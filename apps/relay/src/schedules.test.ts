import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import type { RelayScheduleProjection } from "@workspace/contracts"

import { ScheduleManager } from "./schedules.js"

const directories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

async function manager(
  overrides: Partial<{
    findInstance: (instanceId: string) => Promise<object | null>
    sendConsoleCommand: (instanceId: string, command: string) => Promise<void>
  }> = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-schedules-"))
  directories.push(directory)
  return ScheduleManager.make({
    enqueueBackup: async () => {
      throw new Error("not used")
    },
    findInstance: overrides.findInstance ?? (async () => null),
    getBackup: async () => null,
    listDatabaseIds: async () => new Set(),
    platformTargetId: "platform",
    relayId: "relay-a",
    runDatabasePower: async () => undefined,
    runInstancePower: async () => undefined,
    sendConsoleCommand: overrides.sendConsoleCommand ?? (async () => undefined),
    stateDirectory: directory,
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
  it("applies a revision and reports its Relay-owned next run", async () => {
    const schedules = await manager()
    const applied = await schedules.apply(projection)

    expect(applied.acknowledgedRevision).toBe(1)
    expect(applied.nextRunAt).toBeTypeOf("number")
    expect(schedules.overview([projection.id]).deployments).toEqual([applied])
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

    expect(started.status).toBe("interrupted")
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
})
