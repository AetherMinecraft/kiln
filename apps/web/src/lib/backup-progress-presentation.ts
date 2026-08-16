import type { BackupTaskPhase } from "@workspace/contracts"

type BackupProgressPresentation = {
  artifacts: ReadonlyArray<{ storageId: string | null }>
  bytes: number | null
  taskBytesCompleted: number
  taskBytesTotal: number | null
  taskCurrentArtifactId: string | null
  taskPhase: BackupTaskPhase | null
}

export function backupDisplayBytes(
  backup: BackupProgressPresentation
): number | null {
  if (backup.bytes !== null) return backup.bytes
  if (!backupShowsUploadArtifact(backup) || backup.taskBytesTotal === null) {
    return null
  }
  const remoteArtifactCount = backup.artifacts.filter(
    (artifact) => artifact.storageId !== null
  ).length
  if (remoteArtifactCount === 0) return null
  if (remoteArtifactCount > 1 && backup.taskCurrentArtifactId === null) {
    return null
  }
  return backup.taskBytesTotal
}

export function backupTaskUploadProgressPercent(
  backup: BackupProgressPresentation
): number | null {
  if (
    !backupShowsUploadArtifact(backup) ||
    backup.taskBytesTotal === null ||
    backup.taskBytesTotal <= 0
  ) {
    return null
  }
  if (backup.taskPhase === "finalizing") return 100
  return Math.min(
    100,
    Math.floor((backup.taskBytesCompleted / backup.taskBytesTotal) * 100)
  )
}

function backupShowsUploadArtifact(
  backup: BackupProgressPresentation
): boolean {
  return (
    backup.taskPhase === "uploading" ||
    (backup.taskPhase === "finalizing" &&
      backup.taskCurrentArtifactId !== null)
  )
}
