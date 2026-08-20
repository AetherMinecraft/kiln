import { Effect } from "effect"

import { signS3BackupDownload } from "./client"
import { loadBackupStorageCredentialEffect } from "./storage"

export const prepareS3BackupDownload = Effect.fnUntraced(function* (input: {
  expiresInSeconds: number
  filename: string
  objectKey: string | null
  storageId: string
}) {
  if (!input.objectKey) {
    return yield* Effect.fail(new Error("Backup object key is unavailable"))
  }
  const storage = yield* loadBackupStorageCredentialEffect(input.storageId)
  if (!storage) {
    return yield* Effect.fail(new Error("Backup destination is unavailable"))
  }
  const download = yield* signS3BackupDownload(
    storage,
    input.objectKey,
    input.filename,
    input.expiresInSeconds
  )
  return { download, sourceName: storage.name }
})
