import { createHash, randomBytes } from "node:crypto"
import { createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, assert, describe, it, layer } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import ZipStream from "zip-stream"

import type {
  BackupCreateTaskInput,
  BackupCreateTaskResult,
  BackupDeleteTaskInput,
  BackupRestoreTaskInput,
  BackupTaskPhase,
  BackupTaskResult,
} from "@workspace/contracts"
import { relayBackupTaskSchema } from "@workspace/contracts"

import {
  BackupManager,
  backupPathIsExcluded,
  createPortableInstanceBackup,
  deleteBackupArtifacts,
  storeCreatedBackup,
} from "./backups.js"
import {
  recoverInterruptedRestores,
  restorePortableInstanceBackup,
} from "./backup-restore.js"
import { loadConfig, type RelayInstanceConfig } from "./config.js"
import { makeRelayStateLayer } from "./effect/state.js"

const testDirectory = mkdtempSync(join(tmpdir(), "kiln-backups-"))

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

describe("Relay backups", () => {
  it("rejects inconsistent task envelopes and result kinds", () => {
    const input = backupInput(4)
    const task = {
      backupId: input.backupId,
      bytesCompleted: 1,
      bytesTotal: 1,
      createdAt: 1,
      currentArtifactId: null,
      currentPath: null,
      error: null,
      finishedAt: 2,
      input,
      inputRefreshRequired: false,
      kind: "create" as const,
      phase: null,
      result: backupResult(0),
      startedAt: 1,
      status: "succeeded" as const,
      taskId: input.taskId,
      updatedAt: 2,
    }
    assert.isTrue(relayBackupTaskSchema.safeParse(task).success)
    const legacyTask = structuredClone(task)
    Reflect.deleteProperty(legacyTask, "currentArtifactId")
    Reflect.deleteProperty(legacyTask, "currentPath")
    Reflect.deleteProperty(legacyTask, "phase")
    const parsedLegacyTask = relayBackupTaskSchema.parse(legacyTask)
    assert.strictEqual(parsedLegacyTask.currentArtifactId, null)
    assert.strictEqual(parsedLegacyTask.currentPath, null)
    assert.strictEqual(parsedLegacyTask.phase, null)
    assert.isFalse(
      relayBackupTaskSchema.safeParse({
        ...task,
        backupId: backupInput(5).backupId,
      }).success
    )
    assert.isFalse(
      relayBackupTaskSchema.safeParse({
        ...task,
        result: { warnings: [] },
      }).success
    )
  })

  it.effect("keeps completed upload progress through finalizing", () =>
    Effect.gen(function* () {
      const localArtifactId = "30000000-0000-4000-8000-000000000001"
      const remoteArtifactId = "30000000-0000-4000-8000-000000000002"
      const input = {
        ...backupInput(12),
        destination: { artifactId: localArtifactId, kind: "local" },
        replicas: [
          {
            allowPrivateNetwork: false,
            artifactId: remoteArtifactId,
            headers: {},
            kind: "s3",
            objectKey: "backups/test.zip",
            uploadUrl: "https://example.com/backups/test.zip",
          },
        ],
      } satisfies BackupCreateTaskInput & { kind: "create" }
      const result = backupResult(12)
      const progress = {
        completed: 0,
        currentArtifactId: null,
        currentPath: null,
        phase: "uploading",
        total: 0,
      } satisfies Parameters<typeof storeCreatedBackup>[3]

      const stored = yield* storeCreatedBackup(
        testConfig(testDirectory),
        input,
        result,
        progress,
        new AbortController().signal,
        (_config, _input, uploaded, _signal, onChunk) => {
          onChunk(1)
          onChunk(uploaded.bytes - 1)
          return Effect.succeed(uploaded)
        }
      )

      assert.strictEqual(progress.completed, result.bytes)
      assert.strictEqual(progress.currentArtifactId, remoteArtifactId)
      assert.strictEqual(progress.phase, "finalizing")
      assert.strictEqual(progress.total, result.bytes)
      assert.deepStrictEqual(stored.artifacts, [
        {
          artifactId: localArtifactId,
          error: null,
          status: "available",
        },
        {
          artifactId: remoteArtifactId,
          error: null,
          status: "available",
        },
      ])
    })
  )

  it.effect("reports deletion progress for each artifact", () =>
    Effect.gen(function* () {
      const localArtifactId = "31000000-0000-4000-8000-000000000001"
      const remoteArtifactId = "31000000-0000-4000-8000-000000000002"
      const input = {
        backupId: "31000000-0000-4000-8000-000000000003",
        destination: { artifactId: localArtifactId, kind: "local" },
        kind: "delete",
        replicas: [
          {
            allowPrivateNetwork: false,
            artifactId: remoteArtifactId,
            deleteUrl: "https://example.com/backups/test.zip",
            headers: {},
            kind: "s3",
            objectKey: "backups/test.zip",
          },
        ],
        target: { id: "instance-1", kind: "instance" },
        taskId: "31000000-0000-4000-8000-000000000004",
      } satisfies BackupDeleteTaskInput & { kind: "delete" }
      const snapshots: Array<{
        currentArtifactId: string | null
        result: Exclude<BackupTaskResult, BackupCreateTaskResult>
      }> = []

      const result = yield* deleteBackupArtifacts(
        testConfig(testDirectory),
        input,
        (currentArtifactId, progress) => {
          snapshots.push({
            currentArtifactId,
            result: structuredClone(progress),
          })
          return Effect.succeed(true)
        },
        () => Effect.succeed({ warnings: [] })
      )

      assert.deepStrictEqual(
        snapshots.map(({ currentArtifactId, result: progress }) => ({
          currentArtifactId,
          outcomes: progress.artifacts ?? [],
        })),
        [
          { currentArtifactId: localArtifactId, outcomes: [] },
          {
            currentArtifactId: localArtifactId,
            outcomes: [
              { artifactId: localArtifactId, error: null, status: "deleted" },
            ],
          },
          {
            currentArtifactId: remoteArtifactId,
            outcomes: [
              { artifactId: localArtifactId, error: null, status: "deleted" },
            ],
          },
          {
            currentArtifactId: remoteArtifactId,
            outcomes: [
              { artifactId: localArtifactId, error: null, status: "deleted" },
              {
                artifactId: remoteArtifactId,
                error: null,
                status: "deleted",
              },
            ],
          },
        ]
      )
      assert.deepStrictEqual(result, snapshots.at(-1)?.result)
    })
  )

  layer(makeRelayStateLayer(join(testDirectory, "relay.sqlite")))((it) => {
    it.effect("runs durable tasks through one Relay-wide worker", () =>
      Effect.gen(function* () {
        let active = 0
        let maxActive = 0
        const executionOrder: Array<number> = []
        let call = 0
        const manager = yield* BackupManager.make({
          config: loadConfig({
            KILN_RELAY_DATA_DIR: testDirectory,
            KILN_RELAY_HOST: "relay.test",
            NODE_ENV: "test",
          }),
          createArchive: async () => {
            const index = call
            call += 1
            active += 1
            maxActive = Math.max(maxActive, active)
            executionOrder.push(index)
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
            active -= 1
            return backupResult(index)
          },
          findInstance: async () => testInstance(),
          isInstanceStopped: async () => true,
        })
        const first = backupInput(1)
        const second = backupInput(2)
        yield* manager.enqueue(first)
        yield* manager.enqueue(second)
        yield* manager.runPending()

        assert.deepStrictEqual(executionOrder, [0, 1])
        assert.strictEqual(maxActive, 1)
        assert.deepStrictEqual(
          (yield* manager.list()).map((task) => task.status),
          ["succeeded", "succeeded"]
        )
      })
    )

    it.effect("cancels a running create task and aborts its archive work", () =>
      Effect.gen(function* () {
        let started: (() => void) | undefined
        const archiveStarted = new Promise<void>((resolveStarted) => {
          started = resolveStarted
        })
        const manager = yield* BackupManager.make({
          config: loadConfig({
            KILN_RELAY_DATA_DIR: testDirectory,
            KILN_RELAY_HOST: "relay.test",
            NODE_ENV: "test",
          }),
          createArchive: (_input, _instance, _progress, signal) =>
            new Promise((_resolveArchive, rejectArchive) => {
              signal.addEventListener(
                "abort",
                () => rejectArchive(signal.reason),
                { once: true }
              )
              started?.()
            }),
          findInstance: async () => testInstance(),
          isInstanceStopped: async () => true,
        })
        const input = backupInput(9)
        yield* manager.enqueue(input)
        const worker = yield* Effect.forkChild(manager.runPending())
        yield* Effect.promise(() => archiveStarted)

        const cancelled = yield* manager.cancel(input.taskId)
        yield* Fiber.join(worker)

        assert.strictEqual(cancelled?.status, "cancelled")
        assert.strictEqual(
          (yield* manager.get(input.taskId))?.error,
          "Cancelled by user"
        )
      })
    )

    it.effect("automatically cancels a create task at the backup timeout", () =>
      Effect.gen(function* () {
        let started: (() => void) | undefined
        const archiveStarted = new Promise<void>((resolveStarted) => {
          started = resolveStarted
        })
        const manager = yield* BackupManager.make({
          config: {
            ...loadConfig({
              KILN_RELAY_DATA_DIR: testDirectory,
              KILN_RELAY_HOST: "relay.test",
              NODE_ENV: "test",
            }),
            backupTimeoutMs: 10,
          },
          createArchive: (_input, _instance, _progress, signal) =>
            new Promise((_resolveArchive, rejectArchive) => {
              signal.addEventListener(
                "abort",
                () => rejectArchive(signal.reason),
                { once: true }
              )
              started?.()
            }),
          findInstance: async () => testInstance(),
          isInstanceStopped: async () => true,
        })
        const input = backupInput(12)
        yield* manager.enqueue(input)
        const worker = yield* Effect.forkChild(manager.runPending())
        yield* Effect.promise(() => archiveStarted)

        yield* TestClock.adjust("10 millis")
        yield* Fiber.join(worker)

        const cancelled = yield* manager.get(input.taskId)
        assert.strictEqual(cancelled?.status, "cancelled")
        assert.strictEqual(
          cancelled?.error,
          "Cancelled after reaching the configured backup timeout"
        )
      })
    )

    it.effect("cancels a queued create task before archive work starts", () =>
      Effect.gen(function* () {
        let archiveCalls = 0
        const manager = yield* BackupManager.make({
          config: loadConfig({
            KILN_RELAY_DATA_DIR: testDirectory,
            KILN_RELAY_HOST: "relay.test",
            NODE_ENV: "test",
          }),
          createArchive: async () => {
            archiveCalls += 1
            return backupResult(11)
          },
          findInstance: async () => testInstance(),
          isInstanceStopped: async () => true,
        })
        const input = backupInput(11)
        yield* manager.enqueue(input)

        const cancelled = yield* manager.cancel(input.taskId)
        yield* manager.runPending()

        assert.strictEqual(cancelled?.status, "cancelled")
        assert.strictEqual(archiveCalls, 0)
        assert.strictEqual(
          (yield* manager.get(input.taskId))?.error,
          "Cancelled by user"
        )
      })
    )
  })

  it.effect("creates an atomic, checksummed archive with safe exclusions", () =>
    Effect.acquireUseRelease(
      Effect.promise(() =>
        import("node:fs/promises").then(({ mkdtemp }) =>
          mkdtemp(resolve(tmpdir(), "kiln-backup-archive-"))
        )
      ),
      (directory) =>
        Effect.gen(function* () {
          const config = loadConfig({
            KILN_RELAY_DATA_DIR: directory,
            KILN_RELAY_HOST: "relay.test",
            NODE_ENV: "test",
          })
          const root = resolve(directory, "instances", "instance-1")
          yield* Effect.promise(() =>
            mkdir(resolve(root, "world"), { recursive: true })
          )
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world", "level.dat"), "level")
          )
          yield* Effect.promise(() =>
            writeFile(resolve(root, "session.lock"), "lock")
          )
          yield* Effect.promise(() =>
            symlink("level.dat", resolve(root, "world", "latest"))
          )

          const progress: {
            completed: number
            currentArtifactId: string | null
            currentPath: string | null
            phase: BackupTaskPhase
            total: number
          } = {
            completed: 0,
            currentArtifactId: null,
            currentPath: null,
            phase: "preparing",
            total: 0,
          }
          const input = backupInput(3)
          yield* Effect.promise(() =>
            mkdir(resolve(directory, "backups"), { recursive: true })
          )
          yield* Effect.promise(() =>
            writeFile(
              resolve(directory, "backups", `.${input.backupId}.stale.partial`),
              "stale"
            )
          )
          const result = yield* Effect.promise(() =>
            createPortableInstanceBackup(
              config,
              input,
              testInstance(),
              progress
            )
          )
          assert.strictEqual(
            result.filename,
            `backup-${input.backupId.slice(0, 8)}.zip`
          )
          const archivePath = resolve(
            directory,
            "backups",
            `${input.backupId}.zip`
          )
          const archive = yield* Effect.promise(() => readFile(archivePath))
          assert.strictEqual(result.bytes, archive.byteLength)
          assert.strictEqual(
            result.checksumSha256,
            createHash("sha256").update(archive).digest("hex")
          )
          assert.strictEqual(progress.completed, 5)
          assert.deepStrictEqual(
            (yield* Effect.promise(() =>
              readdir(resolve(directory, "backups"))
            )).filter((name) => name.endsWith(".partial")),
            []
          )
          assert.include(result.warnings[0] ?? "", "world/latest")
          assert.isTrue(
            backupPathIsExcluded("session.lock", false, ["session.lock"])
          )
          assert.isTrue(
            backupPathIsExcluded("logs/debug.log", false, ["logs/**"])
          )
          assert.isFalse(
            backupPathIsExcluded("world/level.dat", false, ["logs/**"])
          )
        }),
      (directory) =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
    )
  )

  it.effect("absorbs late stream errors after archive cancellation", () =>
    Effect.acquireUseRelease(
      temporaryDirectory("kiln-backup-cancel-"),
      (directory) =>
        Effect.promise(async () => {
          const config = testConfig(directory)
          const root = resolve(directory, "instances", "instance-1")
          await mkdir(root, { recursive: true })
          await writeFile(
            resolve(root, "large.bin"),
            randomBytes(8 * 1024 * 1024)
          )
          const controller = new AbortController()
          const progress = {
            completed: 0,
            currentArtifactId: null,
            currentPath: null,
            phase: "preparing" as const,
            total: 0,
          }
          const input = backupInput(10)
          const archiveRejected = createPortableInstanceBackup(
            config,
            input,
            testInstance(),
            progress,
            controller.signal
          ).then(
            () => false,
            () => true
          )
          while (progress.completed === 0) {
            await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
          }

          controller.abort()
          assert.isTrue(await archiveRejected)
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))

          assert.isFalse(
            existsSync(resolve(directory, "backups", `${input.backupId}.zip`))
          )
        }),
      removeTemporaryDirectory
    )
  )

  it.effect("restores a verified archive through a staged directory swap", () =>
    Effect.acquireUseRelease(
      temporaryDirectory("kiln-backup-restore-"),
      (directory) =>
        Effect.gen(function* () {
          const config = testConfig(directory)
          const root = resolve(directory, "instances", "instance-1")
          yield* Effect.promise(() => mkdir(root, { recursive: true }))
          yield* Effect.promise(() =>
            writeFile(resolve(root, "server.txt"), "old")
          )
          const input = backupInput(6)
          const created = yield* Effect.promise(() =>
            createPortableInstanceBackup(config, input, testInstance(), {
              completed: 0,
              currentArtifactId: null,
              currentPath: null,
              phase: "preparing",
              total: 0,
            })
          )
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(resolve(root, "server.txt"), "new"),
              writeFile(resolve(root, "extra.txt"), "remove"),
            ])
          )
          const restore: BackupRestoreTaskInput & { kind: "restore" } = {
            backupId: input.backupId,
            bytes: created.bytes,
            checksumSha256: created.checksumSha256,
            kind: "restore",
            source: { kind: "local" },
            target: { id: "instance-1", kind: "instance" },
            taskId: "20000000-0000-4000-8000-000000000006",
          }
          const result = yield* Effect.promise(() =>
            restorePortableInstanceBackup(config, restore, testInstance())
          )
          assert.deepStrictEqual(result.warnings, [])
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(resolve(root, "server.txt"), "utf8")
            ),
            "old"
          )
          const restored = yield* Effect.promise(() => readdir(root))
          assert.notInclude(restored, "extra.txt")
          assert.notInclude(restored, ".kiln-backup")
        }),
      removeTemporaryDirectory
    )
  )

  it.effect("finishes a journaled directory swap after Relay restart", () =>
    Effect.acquireUseRelease(
      temporaryDirectory("kiln-backup-recovery-"),
      (directory) =>
        Effect.gen(function* () {
          const config = testConfig(directory)
          const taskId = "20000000-0000-4000-8000-000000000007"
          const parent = resolve(directory, "instances")
          const staging = resolve(parent, `.instance-1.kiln-restore-${taskId}`)
          const rollback = resolve(
            parent,
            `.instance-1.kiln-rollback-${taskId}`
          )
          const journals = resolve(directory, "restores")
          yield* Effect.promise(() =>
            Promise.all([
              mkdir(staging, { recursive: true }),
              mkdir(rollback, { recursive: true }),
              mkdir(journals, { recursive: true }),
            ])
          )
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(resolve(staging, "server.txt"), "restored"),
              writeFile(resolve(rollback, "server.txt"), "original"),
              writeFile(
                resolve(journals, `${taskId}.json`),
                JSON.stringify({
                  instanceDirectory: "instance-1",
                  phase: "moved_original",
                  taskId,
                  version: 1,
                })
              ),
            ])
          )
          assert.deepStrictEqual(
            yield* Effect.promise(() => recoverInterruptedRestores(config)),
            [taskId]
          )
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(resolve(parent, "instance-1", "server.txt"), "utf8")
            ),
            "restored"
          )
          assert.notInclude(
            yield* Effect.promise(() => readdir(parent)),
            `.instance-1.kiln-rollback-${taskId}`
          )
        }),
      removeTemporaryDirectory
    )
  )

  it.effect("rejects archive paths that escape the restore staging root", () =>
    Effect.acquireUseRelease(
      temporaryDirectory("kiln-backup-traversal-"),
      (directory) =>
        Effect.gen(function* () {
          const config = testConfig(directory)
          const root = resolve(directory, "instances", "instance-1")
          const input = backupInput(8)
          const archivePath = resolve(
            directory,
            "backups",
            `${input.backupId}.zip`
          )
          yield* Effect.promise(() =>
            Promise.all([
              mkdir(root, { recursive: true }),
              mkdir(resolve(directory, "backups"), { recursive: true }),
            ])
          )
          yield* Effect.promise(() =>
            writeTestArchive(archivePath, "safe123.txt")
          )
          yield* Effect.promise(() =>
            replaceArchiveEntryName(archivePath, "safe123.txt", "../evil.txt")
          )
          const archive = yield* Effect.promise(() => readFile(archivePath))
          const failed = yield* Effect.promise(async () => {
            try {
              await restorePortableInstanceBackup(
                config,
                {
                  backupId: input.backupId,
                  bytes: archive.byteLength,
                  checksumSha256: createHash("sha256")
                    .update(archive)
                    .digest("hex"),
                  kind: "restore",
                  source: { kind: "local" },
                  target: input.target,
                  taskId: "20000000-0000-4000-8000-000000000008",
                },
                testInstance()
              )
              return false
            } catch {
              return true
            }
          })
          assert.isTrue(failed)
          assert.isFalse(existsSync(resolve(directory, "evil.txt")))
        }),
      removeTemporaryDirectory
    )
  )
})

function temporaryDirectory(prefix: string) {
  return Effect.promise(() =>
    import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(resolve(tmpdir(), prefix))
    )
  )
}

function removeTemporaryDirectory(directory: string) {
  return Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
}

function testConfig(directory: string) {
  return loadConfig({
    KILN_RELAY_DATA_DIR: directory,
    KILN_RELAY_HOST: "relay.test",
    NODE_ENV: "test",
  })
}

function writeTestArchive(path: string, name: string): Promise<void> {
  return new Promise((resolveArchive, rejectArchive) => {
    const archive = new ZipStream({ forceZip64: true })
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 })
    archive.once("error", rejectArchive)
    output.once("error", rejectArchive)
    output.once("close", resolveArchive)
    archive.pipe(output)
    archive.entry(Buffer.from("unsafe"), { name }, (cause) => {
      if (cause) rejectArchive(cause)
      else archive.finalize()
    })
  })
}

async function replaceArchiveEntryName(
  path: string,
  original: string,
  replacement: string
): Promise<void> {
  assert.strictEqual(original.length, replacement.length)
  const archive = await readFile(path)
  const source = Buffer.from(original)
  const target = Buffer.from(replacement)
  let replacements = 0
  for (let offset = archive.indexOf(source); offset !== -1;) {
    target.copy(archive, offset)
    replacements += 1
    offset = archive.indexOf(source, offset + target.length)
  }
  assert.isAtLeast(replacements, 2)
  await writeFile(path, archive)
}

function backupInput(
  index: number
): BackupCreateTaskInput & { kind: "create" } {
  const suffix = String(index).padStart(12, "0")
  return {
    artifactKind: "archive",
    backupId: `00000000-0000-4000-8000-${suffix}`,
    destination: { kind: "local" },
    exclude: [],
    kind: "create",
    maxBytes: 100 * 1024 * 1024,
    mode: "full",
    reason: "manual",
    target: { id: "instance-1", kind: "instance" },
    taskId: `10000000-0000-4000-8000-${suffix}`,
  }
}

function backupResult(index: number): BackupCreateTaskResult {
  return {
    bytes: index + 1,
    checksumSha256: String(index).repeat(64),
    filename: `backup-${index}.zip`,
    warnings: [],
  }
}

function testInstance(): RelayInstanceConfig {
  return {
    connectAddress: "relay.test",
    directory: "instance-1",
    game: "minecraft",
    id: "instance-1",
    implementation: "paper",
    javaVersion: "21",
    limits: { diskBytes: 0, memoryBytes: 0 },
    managedByRelay: true,
    name: "Instance One",
    ports: [],
    service: "kiln-instance-1",
    shortId: "instance-1",
    tailscale: { enabled: false },
    version: "1.21.8",
  }
}
