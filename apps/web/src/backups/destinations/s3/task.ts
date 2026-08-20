import { Effect } from "effect"

import type { ResticRepositoryLocation } from "@workspace/contracts"

import {
  invalidBackupDestination,
  type BackupDestinationTaskDriver,
} from "../types"
import {
  signS3BackupDelete,
  signS3BackupRestore,
  signS3BackupUpload,
} from "./client"
import { loadBackupStorageCredentialEffect } from "./storage"

export const s3BackupDestinationTaskDriver = {
  kind: "s3",
  prepareFullCreate: (input) =>
    Effect.gen(function* () {
      if (!input.objectKey) {
        return yield* invalidBackupDestination(
          "An S3 backup is missing its remote object key"
        )
      }
      const storage = yield* availableStorage(input.storageId, true)
      return {
        ...(yield* signS3BackupUpload(storage, input.objectKey)),
        artifactId: input.artifactId,
      }
    }),
  prepareFullDelete: (input) =>
    Effect.gen(function* () {
      if (!input.objectKey) {
        return yield* invalidBackupDestination(
          "An S3 backup is missing its remote object key"
        )
      }
      const storage = yield* availableStorage(input.storageId, false)
      return {
        ...(yield* signS3BackupDelete(storage, input.objectKey)),
        artifactId: input.artifactId,
      }
    }),
  prepareFullRestore: (input) =>
    Effect.gen(function* () {
      if (!input.objectKey) {
        return yield* invalidBackupDestination(
          "An S3 backup is missing its remote object key"
        )
      }
      const storage = yield* availableStorage(input.storageId, false, true)
      return {
        ...(yield* signS3BackupRestore(storage, input.objectKey)),
        bytes: input.bytes,
        checksumSha256: input.checksumSha256,
      }
    }),
  prepareResticRepository: (input) =>
    Effect.gen(function* () {
      if (!input.objectPrefix) {
        return yield* invalidBackupDestination(
          "The restic repository is unavailable"
        )
      }
      const storage = yield* availableStorage(
        input.storageId,
        input.requireEnabled
      )
      return {
        accessKeyId: storage.accessKeyId,
        allowPrivateNetwork: storage.allowPrivateNetwork,
        bucket: storage.bucket,
        endpoint: storage.endpoint,
        forcePathStyle: storage.forcePathStyle,
        kind: "s3",
        region: storage.region,
        repositoryPrefix: input.objectPrefix,
        secretAccessKey: storage.secretAccessKey,
      } satisfies ResticRepositoryLocation
    }),
} satisfies BackupDestinationTaskDriver<"s3">

const availableStorage = Effect.fnUntraced(function* (
  storageId: string | null,
  requireEnabled: boolean,
  allowDeleting = false
) {
  if (!storageId) {
    return yield* invalidBackupDestination(
      "The backup destination is unavailable"
    )
  }
  const storage = yield* loadBackupStorageCredentialEffect(storageId)
  if (
    !storage ||
    (!allowDeleting && storage.deleting) ||
    (requireEnabled && !storage.enabled)
  ) {
    return yield* invalidBackupDestination(
      "The backup destination is unavailable"
    )
  }
  return storage
})
