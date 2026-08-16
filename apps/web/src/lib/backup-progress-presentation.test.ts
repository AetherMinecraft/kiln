import { describe, expect, it } from "vite-plus/test"

import {
  backupDisplayFilename,
  backupDisplayBytes,
  backupShowsPrimaryTaskFeedback,
  backupShowsUploadArtifact,
  backupTaskUploadProgressPercent,
} from "@/lib/backup-progress-presentation"

type TestBackup = Parameters<typeof backupDisplayBytes>[0] &
  Parameters<typeof backupDisplayFilename>[0] &
  Parameters<typeof backupShowsPrimaryTaskFeedback>[0]

const uploadingBackup = {
  artifactKind: "archive",
  artifacts: [{ storageId: "storage-1" }],
  bytes: null,
  filename: null,
  id: "00000000-0000-4000-8000-000000000001",
  taskBytesCompleted: 25,
  taskBytesTotal: 100,
  taskCurrentArtifactId: "artifact-1",
  taskError: null,
  taskKind: "create",
  taskPhase: "uploading",
  taskStatus: "running",
} satisfies TestBackup

describe("backup progress presentation", () => {
  it("keeps restore feedback in the primary columns and delete feedback out", () => {
    const activeRestore = {
      ...uploadingBackup,
      taskCurrentArtifactId: null,
      taskKind: "restore",
      taskPhase: "preparing",
    } satisfies TestBackup
    const activeDelete = {
      ...activeRestore,
      taskKind: "delete",
    } satisfies TestBackup

    expect(backupShowsPrimaryTaskFeedback(activeRestore)).toBe(true)
    expect(backupShowsPrimaryTaskFeedback(activeDelete)).toBe(false)
  })

  it("shows determinate upload progress and the archived size", () => {
    expect(backupDisplayBytes(uploadingBackup)).toBe(100)
    expect(backupShowsPrimaryTaskFeedback(uploadingBackup)).toBe(false)
    expect(backupShowsUploadArtifact(uploadingBackup)).toBe(true)
    expect(backupTaskUploadProgressPercent(uploadingBackup)).toBe(25)
  })

  it("keeps the completed upload presentation while finalizing", () => {
    const backup = {
      ...uploadingBackup,
      taskBytesCompleted: 100,
      taskPhase: "finalizing",
    } satisfies TestBackup

    expect(backupDisplayBytes(backup)).toBe(100)
    expect(backupDisplayFilename(backup)).toBe("backup-00000000.zip")
    expect(backupShowsPrimaryTaskFeedback(backup)).toBe(false)
    expect(backupShowsUploadArtifact(backup)).toBe(true)
    expect(backupTaskUploadProgressPercent(backup)).toBe(100)
  })

  it("does not treat archive finalization bytes as the artifact size", () => {
    const backup = {
      ...uploadingBackup,
      taskBytesCompleted: 800,
      taskBytesTotal: 800,
      taskCurrentArtifactId: null,
      taskPhase: "finalizing",
    } satisfies TestBackup

    expect(backupDisplayBytes(backup)).toBeNull()
    expect(backupDisplayFilename(backup)).toBe(backup.id)
    expect(backupShowsPrimaryTaskFeedback(backup)).toBe(true)
    expect(backupShowsUploadArtifact(backup)).toBe(false)
    expect(backupTaskUploadProgressPercent(backup)).toBeNull()
  })
})
