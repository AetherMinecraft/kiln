import { describe, expect, it } from "vite-plus/test"

import { systemUpdateProgress } from "./system-update-progress"

describe("system update progress", () => {
  it("maps replacement phases to descriptive, monotonic progress", () => {
    const phases = [
      "replace.inspectContainer",
      "replace.tagTarget",
      "replace.stopCurrent",
      "replace.renameCurrent",
      "replace.createTarget",
      "replace.connectNetwork",
      "replace.startTarget",
      "replace.waitUntilHealthy",
      "replace.removeBackup",
    ]
    const progress = phases.map((phase) => systemUpdateProgress(phase, false))
    const percentages = progress.map(({ percent }) => percent)

    expect(percentages).toEqual(
      Array.from(percentages).sort((left, right) => left - right)
    )
    expect(progress).toContainEqual({
      label: "Starting container",
      percent: 76,
    })
    expect(progress).toContainEqual({
      label: "Waiting for health check",
      percent: 90,
    })
    expect(progress.every(({ label }) => label.length <= 24)).toBe(true)
  })

  it("does not overstate work before a detailed phase is available", () => {
    expect(systemUpdateProgress("Preparing", false)).toEqual({
      label: "Preparing update",
      percent: 5,
    })
    expect(systemUpdateProgress("unrecognized.phase", false)).toEqual({
      label: "Preparing update",
      percent: 5,
    })
  })

  it("identifies replacement cleanup as container cleanup", () => {
    expect(systemUpdateProgress("replace.removeBackup", false)).toEqual({
      label: "Removing old container",
      percent: 96,
    })
  })

  it("shows expected connection loss as reconnecting", () => {
    expect(systemUpdateProgress("replace.stopCurrent", true)).toEqual({
      label: "Reconnecting to Kiln",
      percent: 88,
    })
  })

  it("holds a completed Hearth row until reload", () => {
    expect(systemUpdateProgress("awaitingReload", false)).toEqual({
      label: "Update complete",
      percent: 100,
    })
  })

  it("briefly marks other completed targets as updated", () => {
    expect(systemUpdateProgress("completed", false)).toEqual({
      label: "Update complete",
      percent: 100,
    })
  })
})
