import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, describe, it } from "@effect/vitest"
import type { CliSftpResponse } from "@workspace/contracts"
import { Cause, Effect, Exit } from "effect"
import { Server, utils, type Connection } from "ssh2"
import { afterEach, beforeEach } from "vite-plus/test"

import type { KilnSession } from "./config.js"
import {
  downloadSftpFileEffect,
  uploadSftpFileEffect,
  withSftpSessionEffect,
} from "./sftp.js"

const root = "/srv/kiln/instances/test/root"
const session: KilnSession = {
  profile: "test",
  token: "kiln_cli_sftp_secret",
  url: "https://kiln.example.test",
}

// ssh2 sometimes serializes an Ed25519 key it cannot parse back, so retry
// until both halves parse, as the Relay does for its own host key.
const hostKey = (() => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = utils.generateKeyPairSync("ed25519")
    const parsed = utils.parseKey(candidate.private)
    if (
      !(parsed instanceof Error) &&
      !(utils.parseKey(candidate.public) instanceof Error)
    ) {
      return { ...candidate, publicSSH: parsed.getPublicSSH() }
    }
  }
  throw new Error("Could not generate a valid Ed25519 test host key")
})()
const hostKeyFingerprint = `SHA256:${createHash("sha256")
  .update(hostKey.publicSSH)
  .digest("base64")}`

// An in-process Relay SFTP endpoint that records the connections and
// passwords it receives.
async function startRelaySftp() {
  const files = new Map<string, Buffer>()
  const passwords: Array<string> = []
  const clients: Array<Connection> = []
  const closed: Array<Promise<unknown>> = []

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.push(client)
    client.on("error", () => undefined)
    closed.push(new Promise<void>((resolve) => client.once("close", resolve)))
    client.on("authentication", (context) => {
      if (context.method !== "password") {
        context.reject(["password"])
        return
      }
      passwords.push(context.password)
      if (context.password === session.token) context.accept()
      else context.reject()
    })
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        acceptSession().on("sftp", (acceptSftp) => {
          const sftp = acceptSftp()
          sftp.on("STAT", (reqId, path) => {
            const data = files.get(path)
            if (!data)
              return sftp.status(reqId, utils.sftp.STATUS_CODE.NO_SUCH_FILE)
            sftp.attrs(reqId, {
              atime: 0,
              gid: 0,
              mode: 0o100644,
              mtime: 0,
              size: data.length,
              uid: 0,
            })
          })
        })
      })
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const connection: CliSftpResponse = {
    host: "127.0.0.1",
    hostKeyFingerprint,
    port: (server.address() as AddressInfo).port,
    root,
    username: "test@example.test",
  }
  return {
    allClosed: () => Promise.all(closed),
    clients,
    close: () => {
      clients.forEach((client) => client.end())
      server.close()
    },
    connection,
    files,
    passwords,
  }
}

let directory = ""
let relay: Awaited<ReturnType<typeof startRelaySftp>> | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kiln-cli-sftp-"))
})

afterEach(async () => {
  relay?.close()
  relay = undefined
  await rm(directory, { force: true, recursive: true })
})

function defectCode(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause) as { code?: string }
  return error.code
}

describe("CLI SFTP transfers", () => {
  it("rejects remote paths that escape the server root before connecting", async () => {
    relay = await startRelaySftp()
    const source = join(directory, "source.jar")
    await writeFile(source, "contents")

    for (const remotePath of ["../../etc/passwd", "plugins/../../x", ""]) {
      const upload = await Effect.runPromiseExit(
        uploadSftpFileEffect({
          connection: relay.connection,
          localPath: source,
          remotePath: remotePath || " ",
          session,
        })
      )
      const download = await Effect.runPromiseExit(
        downloadSftpFileEffect({
          connection: relay.connection,
          localPath: join(directory, "download"),
          remotePath,
          session,
        })
      )
      assert.strictEqual(defectCode(upload), "invalid_arguments", remotePath)
      assert.strictEqual(defectCode(download), "invalid_arguments", remotePath)
    }
    assert.strictEqual(relay.clients.length, 0)
  })

  it("never sends the token to a server with an unexpected host key", async () => {
    relay = await startRelaySftp()

    const exit = await Effect.runPromiseExit(
      downloadSftpFileEffect({
        connection: {
          ...relay.connection,
          hostKeyFingerprint: `SHA256:${Buffer.alloc(32).toString("base64")}`,
        },
        localPath: join(directory, "download"),
        remotePath: "server.jar",
        session,
      })
    )

    assert.strictEqual(defectCode(exit), "sftp_failed")
    assert.deepStrictEqual(relay.passwords, [])
  })
})

describe("CLI SFTP sessions", () => {
  it("reuses one authenticated connection for a multi-step session", async () => {
    relay = await startRelaySftp()
    relay.files.set(`${root}/a.txt`, Buffer.from("a"))
    relay.files.set(`${root}/b.txt`, Buffer.from("b"))

    const sizes = await Effect.runPromise(
      withSftpSessionEffect(session, relay.connection, (sftp) =>
        Effect.forEach(["a.txt", "b.txt"], (name) =>
          Effect.callback<number>((resume) => {
            sftp.stat(`${root}/${name}`, (error, stats) =>
              resume(error ? Effect.die(error) : Effect.succeed(stats.size))
            )
          })
        )
      )
    )

    assert.deepStrictEqual(sizes, [1, 1])
    assert.lengthOf(relay.clients, 1)
    await relay.allClosed()
  })
})
