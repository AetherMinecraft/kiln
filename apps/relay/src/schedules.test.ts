import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import type {
  BackupTaskInput,
  RelayBackupTask,
  RelayScheduleProjection,
} from "@workspace/contracts"
import {
  nextScheduleOccurrence,
  scheduleActionSupportsTarget,
} from "@workspace/contracts"

import { ScheduleManager } from "./schedules.js"

const directories: Array<string> = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

async function manager(
  overrides: Partial<{
    backupPollIntervalMs: number
    backupWaitTimeoutMs: number
    enqueueBackup: (input: BackupTaskInput) => Promise<RelayBackupTask>
    findInstance: (instanceId: string) => Promise<object | null>
    getBackup: (taskId: string) => Promise<RelayBackupTask | null>
    reportError: (message: string, cause: unknown) => void
    sendConsoleCommand: (instanceId: string, command: string) => Promise<void>
    tickIntervalMs: number
    tickRetryBaseMs: number
  }> = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-schedules-"))
  directories.push(directory)
  return ScheduleManager.make({
    backupPollIntervalMs: overrides.backupPollIntervalMs,
    backupWaitTimeoutMs: overrides.backupWaitTimeoutMs,
    enqueueBackup:
      overrides.enqueueBackup ??
      (async () => {
        throw new Error("not used")
      }),
    findInstance: overrides.findInstance ?? (async () => null),
    getBackup: overrides.getBackup ?? (async () => null),
    listDatabaseIds: async () => new Set(),
    platformTargetId: "platform",
    relayId: "relay-a",
    reportError: overrides.reportError,
    runDatabasePower: async () => undefined,
    runInstancePower: async () => undefined,
    sendConsoleCommand: overrides.sendConsoleCommand ?? (async () => undefined),
    stateDirectory: directory,
    tickIntervalMs: overrides.tickIntervalMs,
    tickRetryBaseMs: overrides.tickRetryBaseMs,
  })
}

const projection: RelayScheduleProjection = {
  actions: [
    {
      command: "say hello",
      id: "8ff172c1-dc22-45fa-8457-b899ca25a8f8",
      type: "console_command",
    },
  ],
  cron: "daily",
  enabled: true,
  id: "14bb1e12-fab9-45f3-8f85-ae22d2f074e5",
  name: "Daily greeting",
  revision: 1,
  targets: [
    {
      id: "server-a",
      kind: "instance",
      name: "Server A",
      relayId: "relay-a",
    },
  ],
  timezone: "UTC",
}

describe("Relay schedule persistence", () => {
  it("does not clone retained state during idle ticks", async () => {
    const schedules = await manager({ tickIntervalMs: 5 })
    const clone = vi.spyOn(globalThis, "structuredClone")

    const fiber = Effect.runFork(schedules.run())
    await Effect.runPromise(Effect.sleep("30 millis"))
    fiber.interruptUnsafe()

    expect(clone).not.toHaveBeenCalled()
  })

  it("keeps the scheduler fiber alive when a tick fails", async () => {
    const reportError = vi.fn()
    const schedules = await manager({
      reportError,
      tickIntervalMs: 5,
      tickRetryBaseMs: 1,
    })
    const directory = directories.at(-1)
    if (!directory) throw new Error("Missing schedule test directory")
    const statePath = join(directory, "schedules.json")
    await rm(statePath, { force: true })
    await mkdir(statePath)

    const fiber = Effect.runFork(schedules.run())
    await vi.waitFor(() => expect(reportError).toHaveBeenCalled(), {
      timeout: 500,
    })

    expect(fiber.pollUnsafe()).toBeUndefined()
    fiber.interruptUnsafe()
  })

  it("applies a revision and reports its Relay-owned next run", async () => {
    const schedules = await manager()
    const applied = await schedules.apply(projection)

    expect(applied.acknowledgedRevision).toBe(1)
    expect(applied.nextRunAt).toBeTypeOf("number")
    expect(schedules.overview([projection.id]).deployments).toEqual([applied])
  })

  it("evaluates cron in the Relay timezone", async () => {
    const now = new Date("2026-01-15T12:00:00.000Z")
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const schedules = await manager()
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    const storedTimezone =
      timezone === "Pacific/Honolulu" ? "UTC" : "Pacific/Honolulu"

    const applied = await schedules.apply({
      ...projection,
      cron: "0 0 * * *",
      timezone: storedTimezone,
    })

    expect(applied.nextRunAt).toBe(
      nextScheduleOccurrence("0 0 * * *", timezone, now).getTime()
    )
    expect(applied.nextRunAt).not.toBe(
      nextScheduleOccurrence("0 0 * * *", storedTimezone, now).getTime()
    )
  })

  it("keeps a tombstone from being replaced by an older revision", async () => {
    const schedules = await manager()
    await schedules.apply(projection)
    await schedules.remove({ revision: 3, scheduleId: projection.id })

    const stale = await schedules.apply({ ...projection, revision: 2 })

    expect(stale).toEqual({
      acknowledgedRevision: 3,
      nextRunAt: null,
      scheduleId: projection.id,
    })
    expect(schedules.overview([projection.id]).deployments).toEqual([])
  })

  it("starts a deployed schedule immediately without changing its next run", async () => {
    const commands: Array<string> = []
    const schedules = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
      },
    })
    const applied = await schedules.apply(projection)

    const started = await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    expect(started.status).toBe("running")
    expect(schedules.overview([projection.id]).deployments[0]?.nextRunAt).toBe(
      applied.nextRunAt
    )
    await vi.waitFor(() => {
      expect(commands).toEqual(["say hello"])
      expect(schedules.overview([projection.id]).runs[0]?.status).toBe(
        "succeeded"
      )
    })
  })

  it("runs a deployed incremental backup with its prepared destination", async () => {
    const inputs: Array<BackupTaskInput> = []
    const schedules = await manager({
      enqueueBackup: async (input) => {
        inputs.push(input)
        return {
          status: "succeeded",
          taskId: input.taskId,
        } as RelayBackupTask
      },
      findInstance: async () => ({}),
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          destination: {
            kind: "storage",
            storageId: "87949dc0-3b2a-4b57-999c-f9bfaf487880",
          },
          executions: [
            {
              destination: {
                kind: "restic",
                repository: { kind: "local" },
                repositoryPassword: "repository-secret",
              },
              mode: "incremental",
              targetId: "server-a",
              targetKind: "instance",
            },
          ],
          id: "6cc00681-a2cd-40c7-a036-7c9bd09b269b",
          mode: "incremental",
          name: "Scheduled snapshot",
          type: "backup",
        },
      ],
    })

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({
        artifactKind: "restic_snapshot",
        catalog: {
          name: expect.stringMatching(
            /^scheduled-\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}Z$/u
          ),
          storageId: "87949dc0-3b2a-4b57-999c-f9bfaf487880",
        },
        destination: {
          artifactId: expect.any(String),
          kind: "restic",
          repositoryPassword: "repository-secret",
        },
        mode: "incremental",
      })
    })
  })

  it("fails a wedged scheduled backup after the configured timeout", async () => {
    const schedules = await manager({
      backupPollIntervalMs: 5,
      backupWaitTimeoutMs: 20,
      enqueueBackup: async (input) =>
        ({ status: "queued", taskId: input.taskId }) as RelayBackupTask,
      findInstance: async () => ({}),
      getBackup: async (taskId) =>
        ({ status: "running", taskId }) as RelayBackupTask,
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          destination: { kind: "local" },
          executions: [
            {
              destination: { kind: "local" },
              mode: "full",
              targetId: "server-a",
              targetKind: "instance",
            },
          ],
          id: "6cc00681-a2cd-40c7-a036-7c9bd09b269b",
          mode: "full",
          name: "Scheduled archive",
          type: "backup",
        },
      ],
    })

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      const run = schedules.overview([projection.id]).runs[0]
      expect(run?.status).toBe("failed")
      expect(run?.targetRuns[0]?.attempts[0]?.error).toBe(
        "Scheduled backup timed out"
      )
    })
  })
})

describe("scheduled action target support", () => {
  it("uses backup mode and power action when checking compatibility", () => {
    expect(
      scheduleActionSupportsTarget(
        { mode: "incremental", type: "backup" },
        { kind: "database" }
      )
    ).toBe(false)
    expect(
      scheduleActionSupportsTarget(
        { mode: "full", type: "backup" },
        { kind: "database" }
      )
    ).toBe(true)
    expect(
      scheduleActionSupportsTarget(
        { action: "kill", type: "power" },
        { kind: "database" }
      )
    ).toBe(false)
  })
})
