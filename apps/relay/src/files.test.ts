import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { buffer as consumeBuffer } from "node:stream/consumers"
import { gzipSync } from "node:zlib"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { pack as createTarPack, type Header as TarHeaders } from "tar-stream"
import ZipStream from "zip-stream"

import { FilesystemDriver } from "./files.js"
import { DeploymentFileSyncDriver, settleFileSyncJournal } from "./file-sync.js"
import { RelayFilesystemError } from "./effect/errors.js"
import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import { testInstance, testRelayConfig } from "./test/fixtures.js"

const describeLinux = process.platform === "linux" ? describe : describe.skip

describeLinux("Relay direct file transfers", () => {
  // A GitHub sync that keeps existing files commits only if the file is
  // still absent, or unchanged since it last wrote it. The checks happen at
  // commit, so a file the instance writes meanwhile survives.
  it.effect("keeps a file created or edited while an upload is in flight", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        const path = resolve(root, "server.properties")
        const failure = (
          effect: Effect.Effect<unknown, RelayFilesystemError>
        ) =>
          effect.pipe(
            Effect.flip,
            Effect.map((error) => error.code)
          )

        // Absent when the upload starts, created before it commits.
        assert.strictEqual(
          yield* failure(
            driver.upload(
              instance,
              "server.properties",
              (async function* () {
                await writeFile(path, "motd=instance\n")
                yield Buffer.from("motd=github\n")
              })(),
              () => true,
              null
            )
          ),
          "file_changed"
        )
        assert.strictEqual(
          yield* fromPromise(() => readFile(path, "utf8")),
          "motd=instance\n"
        )
        // What's there, so a caller can tell its own write from an edit.
        // The Git blob ID `git hash-object` gives this content.
        assert.strictEqual(
          (yield* driver.fingerprint(instance, "server.properties"))?.blob,
          createHash("sha1").update("blob 14\0motd=instance\n").digest("hex")
        )
        assert.isNull(yield* driver.fingerprint(instance, "missing.properties"))

        // Unchanged since the last upload: replaced.
        const before = Math.floor(
          (yield* fromPromise(() => stat(path))).mtimeMs
        )
        const replaced = yield* driver.upload(
          instance,
          "server.properties",
          chunks("motd=github\n"),
          () => true,
          before
        )
        assert.strictEqual(
          yield* fromPromise(() => readFile(path, "utf8")),
          "motd=github\n"
        )

        // Edited while the next upload streams: kept.
        assert.strictEqual(
          yield* failure(
            driver.upload(
              instance,
              "server.properties",
              (async function* () {
                await writeFile(path, "motd=edited\n")
                await utimes(path, new Date(), new Date(Date.now() + 60_000))
                yield Buffer.from("motd=newer\n")
              })(),
              () => true,
              Date.parse(replaced.modifiedAt)
            )
          ),
          "file_changed"
        )
        assert.strictEqual(
          yield* fromPromise(() => readFile(path, "utf8")),
          "motd=edited\n"
        )
      })
    )
  )

  it.effect(
    "rejects unsafe, duplicate, and link archive entries without output",
    () =>
      withSetup(({ driver, instance, root }) =>
        Effect.gen(function* () {
          const cases = [
            {
              archive: "unsafe.tar.gz",
              destination: "unsafe-tar",
              expectedCode: "unsafe_archive_path",
              write: () =>
                writeTarGzArchive(resolve(root, "world", "unsafe.tar.gz"), [
                  { content: "safe", name: "first.txt" },
                  { content: "escape", name: "../escape.txt" },
                ]),
            },
            {
              archive: "duplicate.tar.gz",
              destination: "duplicate-tar",
              expectedCode: "duplicate_archive_path",
              write: () =>
                writeTarGzArchive(resolve(root, "world", "duplicate.tar.gz"), [
                  { content: "first", name: "same.txt" },
                  { content: "second", name: "same.txt" },
                ]),
            },
            {
              archive: "link.tar.gz",
              destination: "link-tar",
              expectedCode: "unsupported_archive_entry",
              write: () =>
                writeTarGzArchive(resolve(root, "world", "link.tar.gz"), [
                  {
                    linkname: "target.txt",
                    name: "linked.txt",
                    type: "symlink",
                  },
                ]),
            },
            {
              archive: "unsafe.zip",
              destination: "unsafe-zip",
              expectedCode: "invalid_archive",
              write: () =>
                writeUnsafeZipArchive(resolve(root, "world", "unsafe.zip")),
            },
            {
              archive: "duplicate.zip",
              destination: "duplicate-zip",
              expectedCode: "duplicate_archive_path",
              write: () =>
                writeZipArchive(resolve(root, "world", "duplicate.zip"), [
                  { content: "first", name: "same.txt" },
                  { content: "second", name: "same.txt" },
                ]),
            },
            {
              archive: "link.zip",
              destination: "link-zip",
              expectedCode: "unsupported_archive_entry",
              write: () =>
                writeZipArchive(resolve(root, "world", "link.zip"), [
                  {
                    linkname: "target.txt",
                    name: "linked.txt",
                    type: "symlink",
                  },
                ]),
            },
          ] as const

          for (const archiveCase of cases) {
            yield* fromPromise(archiveCase.write)
            const failure = yield* driver
              .mutate(instance, {
                operation: "unarchive",
                path: `world/${archiveCase.archive}`,
                destination: `world/${archiveCase.destination}`,
              })
              .pipe(Effect.flip)

            assert.instanceOf(failure, RelayFilesystemError)
            assert.strictEqual(failure.code, archiveCase.expectedCode)
            const worldEntries = yield* fromPromise(() =>
              readdir(resolve(root, "world"))
            )
            assert.notInclude(worldEntries, "escape.txt")
            assert.isFalse(
              worldEntries.some(
                (entry) =>
                  entry === archiveCase.destination ||
                  entry.startsWith(`${archiveCase.destination}.`)
              )
            )
          }
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

  it.effect("keeps the original file when an upload fails partway", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        yield* driver.upload(instance, "world/data.txt", chunks("original"))

        const uploadFailure = yield* driver
          .upload(instance, "world/data.txt", failingChunks())
          .pipe(Effect.flip)
        assert.instanceOf(uploadFailure, RelayFilesystemError)

        const entries = yield* fromPromise(() =>
          readdir(resolve(root, "world"))
        )
        assert.deepEqual(entries, ["data.txt"])
        assert.strictEqual(
          yield* fromPromise(() =>
            readFile(resolve(root, "world", "data.txt"), "utf8")
          ),
          "original"
        )
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
    config: RelayConfig
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
        const config = testRelayConfig(directory)
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

async function writeTarGzArchive(
  path: string,
  entries: ReadonlyArray<{
    content?: string
    linkname?: string
    mode?: number
    name: string
    type?: TarHeaders["type"]
  }>
): Promise<void> {
  const archive = createTarPack()
  const packed = consumeBuffer(archive)
  for (const entry of entries) {
    archive.entry(
      {
        linkname: entry.linkname,
        mode: entry.mode,
        name: entry.name,
        type: entry.type ?? "file",
      },
      Buffer.from(entry.content ?? "")
    )
  }
  archive.finalize()
  await writeFile(path, gzipSync(await packed))
}

async function writeZipArchive(
  path: string,
  entries: ReadonlyArray<{
    content?: string
    linkname?: string
    name: string
    type?: "directory" | "file" | "symlink"
  }>
): Promise<void> {
  const archive = new ZipStream({ forceZip64: true })
  const packed = consumeBuffer(archive)
  for (const entry of entries) {
    await new Promise<void>((resolveEntry, rejectEntry) => {
      archive.entry(
        Buffer.from(entry.content ?? ""),
        {
          linkname: entry.linkname,
          name: entry.name,
          type: entry.type ?? "file",
        },
        (cause) => {
          if (cause) rejectEntry(cause)
          else resolveEntry()
        }
      )
    })
  }
  archive.finalize()
  await writeFile(path, await packed)
}

async function writeUnsafeZipArchive(path: string): Promise<void> {
  const safeName = "aa/escape.txt"
  const unsafeName = "../escape.txt"
  await writeZipArchive(path, [
    { content: "safe", name: "first.txt" },
    { content: "escape", name: safeName },
  ])
  const archive = await readFile(path)
  const safeBytes = Buffer.from(safeName)
  const unsafeBytes = Buffer.from(unsafeName)
  assert.strictEqual(safeBytes.length, unsafeBytes.length)
  let replacements = 0
  let offset = archive.indexOf(safeBytes)
  while (offset >= 0) {
    unsafeBytes.copy(archive, offset)
    replacements += 1
    offset = archive.indexOf(safeBytes, offset + safeBytes.length)
  }
  assert.isAtLeast(replacements, 2)
  await writeFile(path, archive)
}

function fromPromise<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  })
}
