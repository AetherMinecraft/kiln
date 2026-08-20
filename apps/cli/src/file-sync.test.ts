import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { CliCommandError } from "./errors.js"
import {
  buildFileSyncPlanEffect,
  runFileSyncEffect,
  type FileSyncTransport,
  type RemoteSyncEntry,
} from "./file-sync.js"

describe("CLI file sync", () => {
  it.effect(
    "plans by size and SHA-256, honors excludes, and uploads recursively",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          yield* fromPromise(async () => {
            await mkdir(resolve(directory, "plugins"))
            await mkdir(resolve(directory, "configs"))
            await mkdir(resolve(directory, "logs"))
            await writeFile(resolve(directory, "plugins", "same.jar"), "same")
            await writeFile(resolve(directory, "plugins", "hash.jar"), "local")
            await writeFile(resolve(directory, "plugins", "size.jar"), "larger")
            await writeFile(
              resolve(directory, "configs", "server.yml"),
              "config"
            )
            await writeFile(resolve(directory, "logs", "latest.log"), "ignored")
            await writeFile(resolve(directory, "scratch.tmp"), "ignored")
          })
          const transport = new MemoryTransport({
            "plugins/hash.jar": "other",
            "plugins/same.jar": "same",
            "plugins/size.jar": "x",
          })

          const output = yield* runFileSyncEffect({
            excludes: ["logs/**", "**/*.tmp"],
            localDirectory: directory,
            planOnly: false,
            server: "relay:instance",
            transport,
          })

          assert.strictEqual(output.type, "files.sync")
          assert.strictEqual(output.result.status, "succeeded")
          assert.deepEqual(
            output.plan.upload.map((file) => [file.path, file.reason]),
            [
              ["configs/server.yml", "missing"],
              ["plugins/hash.jar", "hash_changed"],
              ["plugins/size.jar", "size_changed"],
            ]
          )
          assert.deepEqual(output.plan.excluded, [
            "logs/latest.log",
            "scratch.tmp",
          ])
          assert.deepEqual(output.plan.createDirectories, ["configs", "logs"])
          assert.deepEqual(transport.createdDirectories, ["configs", "logs"])
          assert.deepEqual([...transport.uploaded].sort(), [
            "configs/server.yml",
            "plugins/hash.jar",
            "plugins/size.jar",
          ])
          assert.strictEqual(output.result.verifiedFiles, 3)
          assert.strictEqual(
            yield* fromPromise(() => transport.hash("configs/server.yml")),
            sha256("config")
          )
          assert.doesNotThrow(() => JSON.parse(JSON.stringify(output)))
        })
      )
  )

  it.effect("returns a complete plan without mutating the Relay", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* fromPromise(() =>
          writeFile(resolve(directory, "server.jar"), "jar")
        )
        const transport = new MemoryTransport()

        const output = yield* runFileSyncEffect({
          excludes: [],
          localDirectory: directory,
          planOnly: true,
          server: "relay:instance",
          transport,
        })

        assert.strictEqual(output.mode, "plan")
        assert.strictEqual(output.result.status, "planned")
        assert.lengthOf(output.plan.upload, 1)
        assert.isEmpty(transport.uploaded)
      })
    )
  )

  it.effect("refuses local symlinks and unsafe exclude traversal", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const target = resolve(directory, "target")
        yield* fromPromise(() => mkdir(target))
        yield* fromPromise(() =>
          symlink(target, resolve(directory, "linked"), "junction")
        )

        const symlinkFailure = yield* buildFileSyncPlanEffect({
          excludes: [],
          localDirectory: directory,
          transport: new MemoryTransport(),
        }).pipe(Effect.flip)
        assert.instanceOf(symlinkFailure, CliCommandError)
        assert.strictEqual(symlinkFailure.exitCode, 10)

        const patternFailure = yield* buildFileSyncPlanEffect({
          excludes: ["../secret"],
          localDirectory: target,
          transport: new MemoryTransport(),
        }).pipe(Effect.flip)
        assert.instanceOf(patternFailure, CliCommandError)
        assert.strictEqual(patternFailure.code, "sync_planning_failed")
      })
    )
  )

  it.effect("refuses remote symlinks and unsafe remote names", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* fromPromise(() =>
          writeFile(resolve(directory, "server.jar"), "jar")
        )
        const symlinkTransport = new MemoryTransport()
        symlinkTransport.setEntry("server.jar", {
          kind: "symlink",
          name: "server.jar",
          size: 3,
        })
        const symlinkFailure = yield* buildFileSyncPlanEffect({
          excludes: [],
          localDirectory: directory,
          transport: symlinkTransport,
        }).pipe(Effect.flip)
        assert.instanceOf(symlinkFailure, CliCommandError)
        assert.strictEqual(symlinkFailure.exitCode, 10)

        const unsafeTransport = new MemoryTransport()
        unsafeTransport.list = async () => [
          { kind: "file", name: "../outside", size: 1 },
        ]
        const unsafeFailure = yield* buildFileSyncPlanEffect({
          excludes: [],
          localDirectory: directory,
          transport: unsafeTransport,
        }).pipe(Effect.flip)
        assert.instanceOf(unsafeFailure, CliCommandError)
        assert.strictEqual(unsafeFailure.code, "sync_planning_failed")
      })
    )
  )

  it.effect("uses distinct transfer and verification failures", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* fromPromise(() =>
          writeFile(resolve(directory, "server.jar"), "jar")
        )
        const transfer = new MemoryTransport()
        transfer.uploadFailure = new Error("interrupted")
        const transferFailure = yield* runFileSyncEffect({
          excludes: [],
          localDirectory: directory,
          planOnly: false,
          server: "relay:instance",
          transport: transfer,
        }).pipe(Effect.flip)
        assert.instanceOf(transferFailure, CliCommandError)
        assert.strictEqual(transferFailure.exitCode, 11)
        assert.strictEqual(transferFailure.code, "sync_transfer_failed")

        const verification = new MemoryTransport()
        verification.corruptUploads = true
        const verificationFailure = yield* runFileSyncEffect({
          excludes: [],
          localDirectory: directory,
          planOnly: false,
          server: "relay:instance",
          transport: verification,
        }).pipe(Effect.flip)
        assert.instanceOf(verificationFailure, CliCommandError)
        assert.strictEqual(verificationFailure.exitCode, 12)
        assert.strictEqual(verificationFailure.code, "sync_verification_failed")
      })
    )
  )
})

class MemoryTransport implements FileSyncTransport {
  readonly contents = new Map<string, Buffer>()
  readonly createdDirectories: Array<string> = []
  readonly entries = new Map<string, RemoteSyncEntry>()
  readonly uploaded: Array<string> = []
  corruptUploads = false
  uploadFailure: Error | null = null

  constructor(files: Readonly<Record<string, string>> = {}) {
    for (const [path, contents] of Object.entries(files)) {
      this.addParents(path)
      const value = Buffer.from(contents)
      this.contents.set(path, value)
      this.entries.set(path, {
        kind: "file",
        name: path.split("/").at(-1) ?? path,
        size: value.byteLength,
      })
    }
  }

  async hash(path: string): Promise<string> {
    const contents = this.contents.get(path)
    if (!contents) throw new Error(`Missing ${path}`)
    return createHash("sha256").update(contents).digest("hex")
  }

  async list(path: string): Promise<ReadonlyArray<RemoteSyncEntry>> {
    const prefix = path ? `${path}/` : ""
    return [...this.entries]
      .filter(([candidate]) => {
        if (!candidate.startsWith(prefix)) return false
        return !candidate.slice(prefix.length).includes("/")
      })
      .map(([, entry]) => entry)
  }

  async mkdir(path: string): Promise<void> {
    this.createdDirectories.push(path)
    this.entries.set(path, {
      kind: "directory",
      name: path.split("/").at(-1) ?? path,
      size: 0,
    })
  }

  async stat(path: string): Promise<RemoteSyncEntry> {
    const entry = this.entries.get(path)
    if (!entry) throw new Error(`Missing ${path}`)
    return entry
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    if (this.uploadFailure) throw this.uploadFailure
    this.uploaded.push(remotePath)
    this.addParents(remotePath)
    const local = await readFile(localPath)
    const contents = this.corruptUploads
      ? Buffer.from(local.map((byte) => byte ^ 0xff))
      : local
    this.contents.set(remotePath, contents)
    this.entries.set(remotePath, {
      kind: "file",
      name: remotePath.split("/").at(-1) ?? remotePath,
      size: contents.byteLength,
    })
  }

  setEntry(path: string, entry: RemoteSyncEntry): void {
    this.addParents(path)
    this.entries.set(path, entry)
  }

  private addParents(path: string): void {
    const segments = path.split("/")
    segments.pop()
    let current = ""
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      if (!this.entries.has(current)) {
        this.entries.set(current, {
          kind: "directory",
          name: segment,
          size: 0,
        })
      }
    }
  }
}

function withDirectory<TResult>(
  use: (directory: string) => Effect.Effect<TResult, unknown>
) {
  return Effect.acquireUseRelease(
    fromPromise(() => mkdtemp(resolve(tmpdir(), "kiln-sync-test-"))),
    use,
    (directory) =>
      fromPromise(() => rm(directory, { force: true, recursive: true })).pipe(
        Effect.orDie
      )
  )
}

function fromPromise<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({ try: run, catch: (cause) => cause })
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
