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

import { CliCommandError, commandError } from "./errors.js"
import {
  buildFileSyncPlanEffect,
  runFileSyncEffect,
  type FileSyncController,
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

  it.effect("stages, verifies, and activates atomic uploads", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* fromPromise(async () => {
          await mkdir(resolve(directory, "plugins"))
          await writeFile(resolve(directory, "plugins", "server.jar"), "new")
        })
        const transport = new MemoryTransport({
          "plugins/server.jar": "old",
        })
        const controller = new MemoryController()

        const output = yield* runFileSyncEffect({
          atomic: true,
          controller,
          deleteManaged: false,
          excludes: [],
          instanceId: "instance",
          localDirectory: directory,
          planOnly: false,
          server: "relay:instance",
          transport,
        })

        assert.strictEqual(output.plan.atomic, true)
        assert.match(output.plan.deploymentId ?? "", /^[0-9a-f-]{36}$/u)
        assert.strictEqual(controller.prepared, 1)
        assert.strictEqual(controller.activated, 1)
        assert.strictEqual(controller.cleaned, 0)
        assert.lengthOf(transport.uploaded, 1)
        assert.strictEqual(
          transport.uploaded[0],
          `${output.plan.stagingPath}/files/plugins/server.jar`
        )
        assert.deepEqual(output.result.activated, ["plugins/server.jar"])
        assert.strictEqual(output.version, 2)
      })
    )
  )

  it.effect(
    "activates empty directories and reserves a custom staging base",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          yield* fromPromise(() => mkdir(resolve(directory, "plugins")))
          const transport = new MemoryTransport()
          const controller = new MemoryController()

          const output = yield* runFileSyncEffect({
            atomic: true,
            controller,
            excludes: [],
            instanceId: "instance",
            localDirectory: directory,
            planOnly: false,
            server: "relay:instance",
            stagingBase: ".deploy",
            transport,
          })

          assert.deepEqual(output.plan.createDirectories, ["plugins"])
          assert.strictEqual(controller.prepared, 1)
          assert.strictEqual(controller.activated, 1)
          assert.deepEqual(output.result.createdDirectories, ["plugins"])
          assert.match(output.plan.stagingPath ?? "", /^\.deploy\//u)
        })
      )
  )

  it.effect("guards managed deletion with a manifest and delete ceiling", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const manifest = resolve(directory, "managed.json")
        yield* fromPromise(() =>
          writeFile(
            manifest,
            JSON.stringify({
              managed: ["plugins/old.jar", "plugins/keep.jar"],
              version: 1,
            })
          )
        )
        const transport = new MemoryTransport({
          "plugins/keep.jar": "keep",
          "plugins/old.jar": "old",
        })

        const limited = yield* buildFileSyncPlanEffect({
          atomic: true,
          deleteManaged: true,
          excludes: [],
          localDirectory: directory,
          manifest,
          maxDelete: 0,
          transport,
        }).pipe(Effect.flip)
        assert.instanceOf(limited, CliCommandError)
        assert.strictEqual(limited.exitCode, 10)

        const plan = yield* buildFileSyncPlanEffect({
          atomic: true,
          deleteManaged: true,
          excludes: ["plugins/keep.jar"],
          localDirectory: directory,
          manifest,
          maxDelete: 1,
          transport,
        })
        assert.deepEqual(
          plan.deletions.map((file) => file.path),
          ["plugins/old.jar"]
        )
        assert.lengthOf(plan.deletions[0]?.sha256 ?? "", 64)
      })
    )
  )

  it.effect("refuses protected managed paths", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const manifest = resolve(directory, "managed.json")
        yield* fromPromise(() =>
          writeFile(
            manifest,
            JSON.stringify({ managed: ["world/level.dat"], version: 1 })
          )
        )
        const failure = yield* buildFileSyncPlanEffect({
          atomic: true,
          deleteManaged: true,
          excludes: [],
          localDirectory: directory,
          manifest,
          maxDelete: 1,
          transport: new MemoryTransport({ "world/level.dat": "world" }),
        }).pipe(Effect.flip)
        assert.instanceOf(failure, CliCommandError)
        assert.strictEqual(failure.exitCode, 10)

        yield* fromPromise(() =>
          writeFile(
            manifest,
            JSON.stringify({ managed: ["../outside"], version: 1 })
          )
        )
        const traversal = yield* buildFileSyncPlanEffect({
          atomic: true,
          deleteManaged: true,
          excludes: [],
          localDirectory: directory,
          manifest,
          maxDelete: 1,
          transport: new MemoryTransport(),
        }).pipe(Effect.flip)
        assert.instanceOf(traversal, CliCommandError)
        assert.strictEqual(traversal.exitCode, 10)
      })
    )
  )

  it.effect("cleans staging after interrupted and corrupt uploads", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* fromPromise(() =>
          writeFile(resolve(directory, "server.jar"), "jar")
        )
        const interrupted = new MemoryTransport()
        interrupted.uploadFailure = new Error("interrupted")
        const interruptedController = new MemoryController()
        const transferFailure = yield* runFileSyncEffect({
          atomic: true,
          controller: interruptedController,
          excludes: [],
          instanceId: "instance",
          localDirectory: directory,
          planOnly: false,
          server: "relay:instance",
          transport: interrupted,
        }).pipe(Effect.flip)
        assert.strictEqual(transferFailure.exitCode, 11)
        assert.strictEqual(interruptedController.cleaned, 1)

        const corrupt = new MemoryTransport()
        corrupt.corruptUploads = true
        const corruptController = new MemoryController()
        const verificationFailure = yield* runFileSyncEffect({
          atomic: true,
          controller: corruptController,
          excludes: [],
          instanceId: "instance",
          localDirectory: directory,
          planOnly: false,
          server: "relay:instance",
          transport: corrupt,
        }).pipe(Effect.flip)
        assert.strictEqual(verificationFailure.exitCode, 12)
        assert.strictEqual(corruptController.cleaned, 1)
      })
    )
  )

  it.effect(
    "uses the activation exit code and cleans after Relay failure",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          yield* fromPromise(() =>
            writeFile(resolve(directory, "server.jar"), "jar")
          )
          const controller = new MemoryController()
          controller.activationFailure = true

          const failure = yield* runFileSyncEffect({
            atomic: true,
            controller,
            excludes: [],
            instanceId: "instance",
            localDirectory: directory,
            planOnly: false,
            server: "relay:instance",
            transport: new MemoryTransport(),
          }).pipe(Effect.flip)

          assert.strictEqual(failure.exitCode, 13)
          assert.strictEqual(failure.code, "sync_activation_failed")
          assert.strictEqual(controller.cleaned, 1)
        })
      )
  )

  it.effect("skips excluded remote directories instead of walking them", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* fromPromise(async () => {
          await mkdir(resolve(directory, "plugins"))
          await writeFile(resolve(directory, "plugins", "one.jar"), "jar")
        })
        const transport = new MemoryTransport({
          "logs/latest.log": "noise",
          "plugins/one.jar": "jar",
          "world/region/r.0.0.mca": "chunks",
        })

        const output = yield* runFileSyncEffect({
          excludes: ["logs", "world"],
          localDirectory: directory,
          planOnly: true,
          server: "relay:instance",
          transport,
        })

        // A deploy costs what it manages, not what happens to sit beside it.
        assert.deepEqual(transport.listed, ["", "plugins"])
        assert.strictEqual(output.plan.summary.remoteFiles, 1)
        assert.deepEqual(output.plan.upload, [])
        assert.deepEqual(
          output.plan.unchanged.map((file) => file.path),
          ["plugins/one.jar"]
        )
      })
    )
  )
})

class MemoryController implements FileSyncController {
  activated = 0
  activationFailure = false
  cleaned = 0
  prepared = 0

  activate(
    input: Parameters<FileSyncController["activate"]>[0]
  ): ReturnType<FileSyncController["activate"]> {
    this.activated += 1
    if (this.activationFailure) {
      return Effect.fail(
        commandError({
          code: "relay_operation_failed",
          message: "Relay activation failed.",
        })
      )
    }
    return Effect.succeed({
      activated: input.files.map((file) => file.path),
      deleted: input.deletions.map((file) => file.path),
      deploymentId: input.deploymentId,
      stagingPath: input.stagingPath,
    })
  }

  cleanup(): ReturnType<FileSyncController["cleanup"]> {
    this.cleaned += 1
    return Effect.succeed({})
  }

  prepare(): ReturnType<FileSyncController["prepare"]> {
    this.prepared += 1
    return Effect.succeed({})
  }
}

class MemoryTransport implements FileSyncTransport {
  readonly contents = new Map<string, Buffer>()
  readonly createdDirectories: Array<string> = []
  readonly entries = new Map<string, RemoteSyncEntry>()
  readonly listed: Array<string> = []
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
    this.listed.push(path)
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
