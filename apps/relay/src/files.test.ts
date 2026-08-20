import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { FileHandle } from "node:fs/promises"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"

import { loadConfig } from "./config.js"
import { FilesystemDriver, MAX_TRANSFER_BYTES } from "./files.js"
import { DeploymentFileSyncDriver, settleFileSyncJournal } from "./file-sync.js"
import { RelayFilesystemError } from "./effect/errors.js"
import type { RelayInstanceConfig } from "./config.js"

const describeLinux = process.platform === "linux" ? describe : describe.skip

describeLinux("Relay direct file transfers", () => {
  it.effect("renames, duplicates, archives, and deletes entries", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        yield* fromPromise(() =>
          writeFile(resolve(root, "world", "data.txt"), "settings")
        )
        yield* driver.mutate(instance, {
          operation: "rename",
          path: "world/data.txt",
          destination: "world/server.txt",
        })
        yield* driver.mutate(instance, {
          operation: "duplicate",
          paths: ["world/server.txt"],
        })
        const archived = yield* driver.mutate(instance, {
          operation: "archive",
          paths: ["world/server.txt", "world/server copy.txt"],
          destination: "world/configs.zip",
        })
        assert.include(archived.paths, "world/configs.zip")
        assert.strictEqual(archived.sizes["world/server.txt"], 8)
        assert.isAtLeast(archived.sizes["world/"] ?? 0, 16)
        assert.strictEqual(archived.sizes[""], archived.sizes["world/"])
        assert.isAbove(archived.modifiedAt["world/server.txt"] ?? 0, 0)
        assert.isAbove(archived.modifiedAt["world/"] ?? 0, 0)
        const archive = yield* fromPromise(() =>
          readFile(resolve(root, "world", "configs.zip"))
        )
        assert.strictEqual(archive.subarray(0, 2).toString(), "PK")

        const deleted = yield* driver.mutate(instance, {
          operation: "delete",
          paths: ["world/server.txt", "world/server copy.txt"],
        })
        assert.notInclude(deleted.paths, "world/server.txt")
        assert.notInclude(deleted.paths, "world/server copy.txt")
      })
    )
  )

  it.effect("atomically uploads and reads through a pinned file handle", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        const uploaded = yield* driver.upload(
          instance,
          "world/data.txt",
          chunks("direct transfer")
        )
        assert.strictEqual(uploaded.size, 15)
        assert.lengthOf(uploaded.sha256, 64)

        const contents = yield* driver.withDownload(
          instance,
          "world/data.txt",
          (download) =>
            fromPromise(async () => {
              assert.strictEqual(download.size, 15)
              return download.file.readFile("utf8")
            })
        )
        assert.strictEqual(contents, "direct transfer")
        assert.isNotEmpty(root)
      })
    )
  )

  it.effect("creates missing parents for concurrent nested uploads", () =>
    withSetup(({ driver, instance }) =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            driver.upload(
              instance,
              "packs/example/config/server.yml",
              chunks("server")
            ),
            driver.upload(
              instance,
              "packs/example/config/messages.yml",
              chunks("messages")
            ),
          ],
          { concurrency: "unbounded" }
        )

        const [server, messages] = yield* Effect.all([
          driver.withDownload(
            instance,
            "packs/example/config/server.yml",
            (download) => fromPromise(() => download.file.readFile("utf8"))
          ),
          driver.withDownload(
            instance,
            "packs/example/config/messages.yml",
            (download) => fromPromise(() => download.file.readFile("utf8"))
          ),
        ])
        assert.strictEqual(server, "server")
        assert.strictEqual(messages, "messages")
      })
    )
  )

  it.effect(
    "collects archive downloads without writing into the instance",
    () =>
      withSetup(({ driver, instance, root }) =>
        Effect.gen(function* () {
          yield* fromPromise(() =>
            Promise.all([
              mkdir(resolve(root, "world", "config")),
              writeFile(resolve(root, "world", "data.txt"), "data"),
            ])
          )
          yield* fromPromise(() =>
            writeFile(resolve(root, "world", "config", "server.yml"), "server")
          )
          const before = yield* fromPromise(() =>
            readdir(resolve(root, "world"))
          )

          const entries = yield* driver.withArchiveDownload(
            instance,
            ["world/config/", "world/data.txt"],
            (downloadEntries) =>
              Effect.succeed(
                downloadEntries.map((entry) => ({
                  kind: entry.kind,
                  name: entry.name,
                }))
              )
          )

          assert.deepInclude(entries, { kind: "directory", name: "config" })
          assert.deepInclude(entries, {
            kind: "file",
            name: "config/server.yml",
          })
          assert.deepInclude(entries, { kind: "file", name: "data.txt" })
          const after = yield* fromPromise(() =>
            readdir(resolve(root, "world"))
          )
          assert.deepEqual(after, before)
          assert.notInclude(after, "selected-files.zip")
        })
      )
  )

  it.effect("refuses a final symlink for transfers and file actions", () =>
    withSetup(({ directory, driver, instance, root }) =>
      Effect.gen(function* () {
        const outside = resolve(directory, "outside.txt")
        yield* fromPromise(() => writeFile(outside, "sensitive"))
        yield* fromPromise(() =>
          symlink(outside, resolve(root, "world", "escape.txt"))
        )

        const downloadFailure = yield* driver
          .withDownload(instance, "world/escape.txt", () => Effect.void)
          .pipe(Effect.flip)
        assert.instanceOf(downloadFailure, RelayFilesystemError)

        const uploadFailure = yield* driver
          .upload(instance, "world/escape.txt", chunks("overwrite"))
          .pipe(Effect.flip)
        assert.instanceOf(uploadFailure, RelayFilesystemError)
        assert.strictEqual(uploadFailure.code, "not_a_file")

        const mutationFailure = yield* driver
          .mutate(instance, {
            operation: "duplicate",
            paths: ["world/escape.txt"],
          })
          .pipe(Effect.flip)
        assert.instanceOf(mutationFailure, RelayFilesystemError)
        assert.strictEqual(mutationFailure.code, "unsupported_file")
      })
    )
  )

  it.effect("refuses symlinks in newly requested upload parents", () =>
    withSetup(({ directory, driver, instance, root }) =>
      Effect.gen(function* () {
        const outside = resolve(directory, "outside")
        yield* fromPromise(() => mkdir(outside))
        yield* fromPromise(() =>
          symlink(outside, resolve(root, "world", "linked"))
        )

        const failure = yield* driver
          .upload(instance, "world/linked/nested.txt", chunks("blocked"))
          .pipe(Effect.flip)
        assert.instanceOf(failure, RelayFilesystemError)
        assert.strictEqual(failure.code, "not_a_directory")
        const outsideEntries = yield* fromPromise(() => readdir(outside))
        assert.isEmpty(outsideEntries)
      })
    )
  )

  it.effect("closes downloads and removes failed upload temporaries", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        yield* driver.upload(instance, "world/data.txt", chunks("original"))

        let downloadHandle: FileHandle | undefined
        yield* driver
          .withDownload(instance, "world/data.txt", (download) =>
            Effect.sync(() => {
              downloadHandle = download.file
              throw new Error("consumer stopped")
            })
          )
          .pipe(Effect.exit)
        assert.strictEqual(downloadHandle?.fd, -1)

        const uploadFailure = yield* driver
          .upload(instance, "world/data.txt", failingChunks())
          .pipe(Effect.flip)
        assert.instanceOf(uploadFailure, RelayFilesystemError)
        assert.strictEqual(uploadFailure.operation, "upload.read")

        const entries = yield* fromPromise(() =>
          readdir(resolve(root, "world"))
        )
        assert.deepEqual(entries, ["data.txt"])
        const contents = yield* driver.withDownload(
          instance,
          "world/data.txt",
          (download) => fromPromise(() => download.file.readFile("utf8"))
        )
        assert.strictEqual(contents, "original")
      })
    )
  )

  it.effect("closes a pinned download descriptor when interrupted", () =>
    withSetup(({ driver, instance }) =>
      Effect.gen(function* () {
        yield* driver.upload(instance, "world/data.txt", chunks("interrupt"))
        const opened = yield* Deferred.make<FileHandle>()
        const fiber = yield* driver
          .withDownload(instance, "world/data.txt", (download) =>
            Deferred.succeed(opened, download.file).pipe(
              Effect.andThen(Effect.never)
            )
          )
          .pipe(Effect.forkChild)
        const handle = yield* Deferred.await(opened)

        yield* Fiber.interrupt(fiber)

        assert.strictEqual(handle.fd, -1)
      })
    )
  )

  it.effect("rejects downloads above the browser transfer limit", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        const oversized = resolve(root, "world", "oversized.bin")
        yield* fromPromise(async () => {
          await writeFile(oversized, "")
          await truncate(oversized, MAX_TRANSFER_BYTES + 1)
        })

        const failure = yield* driver
          .withDownload(instance, "world/oversized.bin", () => Effect.void)
          .pipe(Effect.flip)

        assert.instanceOf(failure, RelayFilesystemError)
        assert.strictEqual(failure.code, "file_too_large")
      })
    )
  )
})

describe("Relay file listing", () => {
  it.effect("lists one subtree without walking the rest of the instance", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        yield* fromPromise(async () => {
          await mkdir(resolve(root, "plugins", "Nested"), { recursive: true })
          await writeFile(resolve(root, "plugins", "one.jar"), "jar")
          await writeFile(resolve(root, "plugins", "Nested", "two.jar"), "jar")
          await writeFile(resolve(root, "world", "level.dat"), "world")
          await writeFile(resolve(root, "server.properties"), "port")
        })

        const scoped = yield* driver.tree(instance, "plugins")

        // Root-relative paths, so a caller can address what it lists.
        assert.deepEqual(scoped.paths.sort(), [
          "plugins/Nested/",
          "plugins/Nested/two.jar",
          "plugins/one.jar",
        ])

        const whole = yield* driver.tree(instance)
        assert.include(whole.paths, "world/level.dat")
        assert.include(whole.paths, "server.properties")
      })
    )
  )

  it.effect("refuses to list outside the instance or list a file", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        yield* fromPromise(() =>
          writeFile(resolve(root, "server.properties"), "port")
        )

        const escaped = yield* driver
          .tree(instance, "../instance-2")
          .pipe(Effect.flip)
        assert.instanceOf(escaped, RelayFilesystemError)
        assert.strictEqual(escaped.code, "invalid_path")

        const notDirectory = yield* driver
          .tree(instance, "server.properties")
          .pipe(Effect.flip)
        assert.instanceOf(notDirectory, RelayFilesystemError)
        assert.strictEqual(notDirectory.code, "not_a_directory")
      })
    )
  )
})

describeLinux("Relay transactional file sync", () => {
  it.effect("atomically activates uploads and removes managed files", () =>
    withSetup(({ config, instance, root }) =>
      Effect.gen(function* () {
        const driver = new DeploymentFileSyncDriver(config)
        const deploymentId = randomUUID()
        const stagingPath = `.kiln/deployments/${deploymentId}`
        yield* fromPromise(async () => {
          await mkdir(resolve(root, "plugins"), { recursive: true })
          await writeFile(resolve(root, "plugins", "server.jar"), "old")
          await writeFile(resolve(root, "plugins", "removed.jar"), "remove")
        })
        yield* driver.prepare(instance, {
          deleteManaged: true,
          deploymentId,
          instanceId: instance.id,
          stagingPath,
        })
        yield* fromPromise(async () => {
          await mkdir(resolve(root, stagingPath, "files", "plugins"), {
            recursive: true,
          })
          await writeFile(
            resolve(root, stagingPath, "files", "plugins", "server.jar"),
            "new"
          )
        })

        const result = yield* driver.activate(instance, {
          deletions: [
            {
              path: "plugins/removed.jar",
              sha256: sha256("remove"),
              size: 6,
            },
          ],
          deploymentId,
          directories: ["configs"],
          files: [
            {
              expectedTarget: { sha256: sha256("old"), size: 3 },
              path: "plugins/server.jar",
              sha256: sha256("new"),
              size: 3,
            },
          ],
          instanceId: instance.id,
          maxDelete: 1,
          stagingPath,
        })

        assert.deepEqual(result.activated, ["plugins/server.jar"])
        assert.deepEqual(result.deleted, ["plugins/removed.jar"])
        assert.isTrue(
          yield* fromPromise(() => pathExists(resolve(root, "configs")))
        )
        assert.strictEqual(
          yield* fromPromise(() =>
            readFile(resolve(root, "plugins", "server.jar"), "utf8")
          ),
          "new"
        )
        assert.isFalse(
          yield* fromPromise(() => pathExists(resolve(root, stagingPath)))
        )
        assert.isFalse(
          yield* fromPromise(() =>
            pathExists(resolve(root, "plugins", "removed.jar"))
          )
        )
      })
    )
  )

  it.effect("rejects hash mismatches and safely cleans staging", () =>
    withSetup(({ config, instance, root }) =>
      Effect.gen(function* () {
        const driver = new DeploymentFileSyncDriver(config)
        const deploymentId = randomUUID()
        const stagingPath = `.kiln/deployments/${deploymentId}`
        yield* fromPromise(() =>
          writeFile(resolve(root, "world", "server.jar"), "old")
        )
        yield* driver.prepare(instance, {
          deleteManaged: false,
          deploymentId,
          instanceId: instance.id,
          stagingPath,
        })
        yield* fromPromise(async () => {
          await mkdir(resolve(root, stagingPath, "files", "world"), {
            recursive: true,
          })
          await writeFile(
            resolve(root, stagingPath, "files", "world", "server.jar"),
            "bad"
          )
        })
        const failure = yield* driver
          .activate(instance, {
            deletions: [],
            deploymentId,
            directories: [],
            files: [
              {
                expectedTarget: { sha256: sha256("old"), size: 3 },
                path: "world/server.jar",
                sha256: sha256("new"),
                size: 3,
              },
            ],
            instanceId: instance.id,
            maxDelete: 0,
            stagingPath,
          })
          .pipe(Effect.flip)
        assert.instanceOf(failure, RelayFilesystemError)
        assert.strictEqual(failure.code, "verification_failed")
        yield* driver.cleanup(instance, {
          deploymentId,
          instanceId: instance.id,
          stagingPath,
        })
        assert.strictEqual(
          yield* fromPromise(() =>
            readFile(resolve(root, "world", "server.jar"), "utf8")
          ),
          "old"
        )
      })
    )
  )

  it.effect("recovers a partially activated deployment", () =>
    withSetup(({ config, root }) =>
      Effect.gen(function* () {
        const deploymentId = randomUUID()
        const stagingPath = `.kiln/deployments/${deploymentId}`
        yield* fromPromise(async () => {
          await mkdir(resolve(root, stagingPath, ".rollback", "plugins"), {
            recursive: true,
          })
          await mkdir(resolve(root, "plugins"), { recursive: true })
          await writeFile(resolve(root, "plugins", "server.jar"), "new")
          await writeFile(
            resolve(root, stagingPath, ".rollback", "plugins", "server.jar"),
            "old"
          )
        })

        yield* fromPromise(() =>
          settleFileSyncJournal(
            config,
            {
              deletions: [],
              deploymentId,
              directories: [],
              files: ["plugins/server.jar"],
              instanceDirectory: "instance-1",
              phase: "activating",
              stagingPath,
              version: 1,
            },
            false
          )
        )

        assert.strictEqual(
          yield* fromPromise(() =>
            readFile(resolve(root, "plugins", "server.jar"), "utf8")
          ),
          "old"
        )
      })
    )
  )

  it.effect("rejects protected deletion and symlinked staging parents", () =>
    withSetup(({ config, directory, instance, root }) =>
      Effect.gen(function* () {
        const driver = new DeploymentFileSyncDriver(config)
        const outside = resolve(directory, "outside")
        const linkedDeployment = randomUUID()
        yield* fromPromise(async () => {
          await mkdir(outside)
          await symlink(outside, resolve(root, "linked"), "junction")
        })
        const symlinkFailure = yield* driver
          .prepare(instance, {
            deleteManaged: false,
            deploymentId: linkedDeployment,
            instanceId: instance.id,
            stagingPath: `linked/${linkedDeployment}`,
          })
          .pipe(Effect.flip)
        assert.instanceOf(symlinkFailure, RelayFilesystemError)

        const deploymentId = randomUUID()
        const stagingPath = `.kiln/deployments/${deploymentId}`
        yield* driver.prepare(instance, {
          deleteManaged: true,
          deploymentId,
          instanceId: instance.id,
          stagingPath,
        })
        const limitFailure = yield* driver
          .activate(instance, {
            deletions: [
              {
                path: "world/data.txt",
                sha256: sha256("settings"),
                size: 8,
              },
            ],
            deploymentId,
            directories: [],
            files: [],
            instanceId: instance.id,
            maxDelete: 0,
            stagingPath,
          })
          .pipe(Effect.flip)
        assert.instanceOf(limitFailure, RelayFilesystemError)
        assert.strictEqual(limitFailure.code, "delete_limit_exceeded")

        const protectedFailure = yield* driver
          .activate(instance, {
            deletions: [
              {
                path: "world/data.txt",
                sha256: sha256("settings"),
                size: 8,
              },
            ],
            deploymentId,
            directories: [],
            files: [],
            instanceId: instance.id,
            maxDelete: 1,
            stagingPath,
          })
          .pipe(Effect.flip)
        assert.instanceOf(protectedFailure, RelayFilesystemError)
        assert.strictEqual(protectedFailure.code, "protected_path")
      })
    )
  )
})

function withSetup<TResult>(
  use: (setup: {
    config: ReturnType<typeof loadConfig>
    directory: string
    driver: FilesystemDriver
    instance: RelayInstanceConfig
    root: string
  }) => Effect.Effect<TResult, unknown>
) {
  return Effect.acquireUseRelease(
    fromPromise(() => mkdtemp(resolve(tmpdir(), "kiln-files-test-"))),
    (directory) =>
      Effect.gen(function* () {
        const root = resolve(directory, "instances", "instance-1")
        yield* fromPromise(() =>
          mkdir(resolve(root, "world"), { recursive: true })
        )
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: directory,
          KILN_RELAY_HOST: "relay.test",
          NODE_ENV: "development",
        })
        return yield* use({
          config,
          directory,
          driver: new FilesystemDriver(config),
          instance: testInstance(),
          root,
        })
      }),
    (directory) =>
      fromPromise(() => rm(directory, { force: true, recursive: true })).pipe(
        Effect.orDie
      )
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause) {
      if (cause.code === "ENOENT") return false
    }
    throw cause
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value)
}

async function* failingChunks(): AsyncIterable<Uint8Array> {
  yield Buffer.from("partial")
  throw new Error("upload stream failed")
}

function fromPromise<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  })
}

function testInstance(): RelayInstanceConfig {
  return {
    connectAddress: "localhost",
    directory: "instance-1",
    game: "Minecraft",
    id: "instance-1",
    implementation: "Paper",
    javaVersion: "21",
    limits: { diskBytes: 0, memoryBytes: 0 },
    managedByRelay: true,
    name: "Test Instance",
    ports: [],
    service: "test",
    shortId: "instance",
    tailscale: { enabled: false },
    version: "1.21.11",
  }
}
