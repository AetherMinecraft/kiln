import { describe, expect, it } from "vite-plus/test"

import {
  backupDisplayBytes,
  backupTaskUploadProgressPercent,
} from "@/lib/backup-progress-presentation"

const uploadingBackup = {
  artifacts: [{ storageId: "storage-1" }],
  bytes: null,
  taskBytesCompleted: 25,
  taskBytesTotal: 100,
  taskCurrentArtifactId: "artifact-1",
  taskPhase: "uploading",
} satisfies Parameters<typeof backupDisplayBytes>[0]

describe("backup progress presentation", () => {
  it("shows determinate upload progress and the archived size", () => {
    expect(backupDisplayBytes(uploadingBackup)).toBe(100)
    expect(backupTaskUploadProgressPercent(uploadingBackup)).toBe(25)
  })

  it("keeps the completed upload presentation while finalizing", () => {
    const backup = {
      ...uploadingBackup,
      taskBytesCompleted: 100,
      taskPhase: "finalizing",
    } satisfies Parameters<typeof backupDisplayBytes>[0]

    expect(backupDisplayBytes(backup)).toBe(100)
    expect(backupTaskUploadProgressPercent(backup)).toBe(100)
  })

  it("does not treat archive finalization bytes as the artifact size", () => {
    const backup = {
      ...uploadingBackup,
      taskBytesCompleted: 800,
      taskBytesTotal: 800,
      taskCurrentArtifactId: null,
      taskPhase: "finalizing",
    } satisfies Parameters<typeof backupDisplayBytes>[0]

    expect(backupDisplayBytes(backup)).toBeNull()
    expect(backupTaskUploadProgressPercent(backup)).toBeNull()
  })
})
