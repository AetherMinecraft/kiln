import { describe, expect, it } from "vite-plus/test"

import { systemUpdateProgress } from "./system-update-progress"

describe("system update progress", () => {
  it("maps replacement phases to short, monotonic progress", () => {
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
    expect(progress.every(({ label }) => label.length <= 12)).toBe(true)
  })

  it("shows expected connection loss as reconnecting", () => {
    expect(systemUpdateProgress("replace.stopCurrent", true)).toEqual({
      label: "Reconnecting",
      percent: 88,
    })
  })

  it("holds a completed Hearth row until reload", () => {
    expect(systemUpdateProgress("awaitingReload", false)).toEqual({
      label: "Updated",
      percent: 100,
    })
  })

  it("briefly marks other completed targets as updated", () => {
    expect(systemUpdateProgress("completed", false)).toEqual({
      label: "Updated",
      percent: 100,
    })
  })
})
