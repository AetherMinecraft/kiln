import { Readable } from "node:stream"

import { Cause, Effect } from "effect"

import {
  claimBackupCopyTaskEffect,
  completeBackupCopyTaskEffect,
  listRunnableBackupCopyTaskIdsEffect,
  type ClaimedBackupCopyTask,
} from "@/effect/backups"
import { loadBackupStorageCredentialEffect } from "@/effect/backup-storage"
import { BackupStorageError } from "@/effect/errors"
import { forkAppEffect } from "@/effect/runtime"
import { signLocalBackupDownload } from "@/lib/backup-download"
import { putS3BackupObject, withS3BackupObject } from "@/lib/backup-storage-s3"
import { listPersistedRelays } from "@/lib/relay-registry"

let copyWorkerRunning = false
let copyWorkerRequested = false

export function scheduleBackupCopyProcessing(): void {
  copyWorkerRequested = true
  if (copyWorkerRunning) return
  copyWorkerRunning = true
  forkAppEffect(
    "backups.copy.worker",
    drainBackupCopyTasksEffect().pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Backup copy worker failed", { cause })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          copyWorkerRunning = false
          if (copyWorkerRequested) queueMicrotask(scheduleBackupCopyProcessing)
        })
      )
    )
  )
}

const drainBackupCopyTasksEffect = Effect.fn("backups.drainCopies")(
  function* () {
    while (copyWorkerRequested) {
      copyWorkerRequested = false
      const taskIds = yield* listRunnableBackupCopyTaskIdsEffect()
      yield* Effect.forEach(taskIds, processBackupCopyTaskEffect, {
        concurrency: 1,
        discard: true,
      })
    }
  }
)

const processBackupCopyTaskEffect = Effect.fn("backups.processCopy")(function* (
  taskId: string
) {
  const task = yield* claimBackupCopyTaskEffect(taskId)
  if (!task) return
  yield* Effect.annotateCurrentSpan({
    backupId: task.backupId,
    destinationStorageId: task.destinationStorageId,
    taskId,
  })
  yield* transferBackupCopyEffect(task).pipe(
    Effect.timeoutOrElse({
      duration: "14 minutes",
      orElse: () => copyFailure("The backup copy timed out"),
    }),
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        const error = backupCopyFailureMessage(cause)
        return completeBackupCopyTaskEffect({
          artifactId: task.destinationArtifactId,
          backupId: task.backupId,
          bytes: null,
          checksumSha256: null,
          error,
          filename: task.filename,
          ok: false,
          taskId: task.taskId,
        }).pipe(
          Effect.tap(() =>
            Effect.logError("Backup copy failed", {
              backupId: task.backupId,
              cause,
              taskId: task.taskId,
            })
          )
        )
      },
      onSuccess: () =>
        completeBackupCopyTaskEffect({
          artifactId: task.destinationArtifactId,
          backupId: task.backupId,
          bytes: task.bytes,
          checksumSha256: task.checksumSha256,
          error: null,
          filename: task.filename,
          ok: true,
          taskId: task.taskId,
        }),
    })
  )
})

const transferBackupCopyEffect = Effect.fn("backups.transferCopy")(function* (
  task: ClaimedBackupCopyTask
) {
  const destination = yield* loadBackupStorageCredentialEffect(
    task.destinationStorageId
  )
  if (!destination) {
    return yield* copyFailure("Backup destination is unavailable")
  }
  if (task.sourceStorageId !== null) {
    if (!task.sourceObjectKey) {
      return yield* copyFailure("Backup object key is unavailable")
    }
    const source = yield* loadBackupStorageCredentialEffect(
      task.sourceStorageId
    )
    if (!source) {
      return yield* copyFailure("Backup source destination is unavailable")
    }
    return yield* withS3BackupObject(
      source,
      task.sourceObjectKey,
      ({ body, contentLength }) =>
        uploadBackupCopyEffect(
          task,
          destination,
          body,
          contentLength ?? task.bytes ?? undefined
        )
    )
  }
  const source = yield* localBackupCopySourceEffect(task)
  yield* uploadBackupCopyEffect(
    task,
    destination,
    source.body,
    source.contentLength
  ).pipe(Effect.ensuring(Effect.sync(() => source.body.destroy())))
})

const localBackupCopySourceEffect = Effect.fn("backups.localCopySource")(
  function* (task: ClaimedBackupCopyTask) {
    if (task.sourceObjectKey) {
      return yield* copyFailure("Local backup metadata is invalid")
    }
    const relays = yield* Effect.tryPromise({
      try: listPersistedRelays,
      catch: (cause) =>
        BackupStorageError.make({
          code: "copy_relay_lookup_failed",
          operation: "backup.copy.relay",
          reason: "The backup Relay is unavailable",
          cause,
        }),
    })
    const relay = relays.find(
      (candidate) => candidate.enabled && candidate.id === task.relayId
    )
    if (!relay) return yield* copyFailure("The backup Relay is unavailable")
    const signed = yield* Effect.tryPromise({
      try: () =>
        signLocalBackupDownload(
          relay,
          { id: task.backupId },
          task.filename,
          task.requestedBy,
          300
        ),
      catch: (cause) =>
        BackupStorageError.make({
          code: "copy_download_sign_failed",
          operation: "backup.copy.signLocal",
          reason: "The local backup could not be prepared for copying",
          cause,
        }),
    })
    if (new URL(signed.url).origin !== new URL(relay.browserOrigin).origin) {
      return yield* copyFailure("The local backup download URL is invalid")
    }
    const response = yield* Effect.tryPromise({
      try: () => fetch(signed.url, { redirect: "error" }),
      catch: (cause) =>
        BackupStorageError.make({
          code: "copy_download_failed",
          operation: "backup.copy.download",
          reason: "The backup file could not be read for copying",
          cause,
        }),
    })
    if (!response.ok || !response.body) {
      return yield* copyFailure("The backup file could not be read for copying")
    }
    const contentLength = Number(response.headers.get("content-length"))
    const body = yield* Effect.try({
      try: () =>
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream
        ),
      catch: (cause) =>
        BackupStorageError.make({
          code: "copy_stream_failed",
          operation: "backup.copy.stream",
          reason: "The backup file could not be streamed for copying",
          cause,
        }),
    })
    return {
      body,
      contentLength:
        Number.isFinite(contentLength) && contentLength > 0
          ? contentLength
          : (task.bytes ?? undefined),
    }
  }
)

function uploadBackupCopyEffect(
  task: ClaimedBackupCopyTask,
  destination: Parameters<typeof putS3BackupObject>[0],
  body: Readable,
  contentLength: number | undefined
) {
  return putS3BackupObject(destination, {
    body,
    ...(contentLength === undefined ? {} : { contentLength }),
    objectKey: task.destinationObjectKey,
  })
}

function copyFailure(reason: string) {
  return BackupStorageError.make({
    code: "copy_failed",
    operation: "backup.copy",
    reason,
  })
}

function backupCopyFailureMessage(cause: Cause.Cause<unknown>): string {
  const failure = Cause.squash(cause)
  return failure instanceof Error
    ? failure.message
    : "The backup could not be copied to that destination"
}
