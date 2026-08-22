import { describe, expect, it } from "vite-plus/test"

import {
  scheduleBackupAllowsIncremental,
  scheduleBackupDestination,
} from "./schedule-backup-configuration"

const instance = {
  canCreate: true,
  canUpdate: true,
  kind: "instance" as const,
  permittedActions: ["backup"] as const,
}

describe("schedule backup configuration", () => {
  it("maps Default to Relay-local storage instead of a storage UUID", () => {
    expect(scheduleBackupDestination("incremental", "default")).toEqual({
      kind: "local",
    })
  })

  it("allows incremental backups when a mixed schedule has an instance target", () => {
    expect(
      scheduleBackupAllowsIncremental(
        [
          instance,
          {
            canCreate: true,
            canUpdate: true,
            kind: "database",
            permittedActions: ["backup"],
          },
        ],
        "canCreate"
      )
    ).toBe(true)
  })

  it("does not allow incremental when no permitted instance can run it", () => {
    expect(
      scheduleBackupAllowsIncremental(
        [{ ...instance, canCreate: false }],
        "canCreate"
      )
    ).toBe(false)
  })
})
