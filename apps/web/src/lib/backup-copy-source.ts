export function selectBackupCopySource<
  TArtifact extends { status: string; storageId: string | null },
>(artifacts: ReadonlyArray<TArtifact>): TArtifact | undefined {
  return (
    artifacts.find(
      (artifact) =>
        artifact.status === "available" && artifact.storageId !== null
    ) ?? artifacts.find((artifact) => artifact.status === "available")
  )
}
