type BackupRelayOperation =
  | {
      operation: "cancel"
      relayId: string
    }
  | {
      operation: "download"
      relayId: string
      storageId: string | null
    }

type LoadBackupRelay<TRelay> = (relayId: string) => Promise<TRelay>

export function resolveBackupRelayForOperation<TRelay>(
  input: Extract<BackupRelayOperation, { operation: "cancel" }>,
  loadRelay: LoadBackupRelay<TRelay>
): Promise<TRelay>
export function resolveBackupRelayForOperation<TRelay>(
  input: Extract<BackupRelayOperation, { operation: "download" }>,
  loadRelay: LoadBackupRelay<TRelay>
): Promise<TRelay | null>
export async function resolveBackupRelayForOperation<TRelay>(
  input: BackupRelayOperation,
  loadRelay: LoadBackupRelay<TRelay>
): Promise<TRelay | null> {
  if (input.operation === "download" && input.storageId !== null) {
    return null
  }
  return loadRelay(input.relayId)
}
