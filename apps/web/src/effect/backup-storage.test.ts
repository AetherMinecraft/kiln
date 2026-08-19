import { describe, expect, it, vi } from "vite-plus/test"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { deleteBackupStorageEffect } from "@/effect/backup-storage"
import { BackupStorageError } from "@/effect/errors"
import { deleteS3BackupPrefix } from "@/lib/backup-storage-s3"

vi.mock("../../keyring.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../keyring.mjs")>()
  return {
    ...actual,
    decryptWithKeyring: (encoded: string) => ({
      needsRotation: false,
      plaintext: encoded.startsWith("enc:") ? encoded.slice(4) : encoded,
      version: 1,
    }),
    encryptWithKeyring: (plaintext: string) => `enc:${plaintext}`,
  }
})

vi.mock("@/lib/environment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/environment")>()
  return {
    ...actual,
    betterAuthSecrets: () => [{ version: 1, value: "x".repeat(32) }],
  }
})

vi.mock("@/lib/backup-storage-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backup-storage-s3")>()
  return {
    ...actual,
    deleteS3BackupPrefix: vi.fn(() => Effect.void),
  }
})

const emptyResult: ResultSetHeader = {
  affectedRows: 0,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

const storageId = "11111111-1111-4111-8111-111111111111"
const repositoryPrefix =
  "team/kiln/kiln.dev/relay-one/restic/instance/instance-one/repo-one"

describe("backup storage deletion", () => {
  it("refuses destinations that still have cataloged backups", async () => {
    await expect(
      Effect.runPromise(
        deleteBackupStorageEffect(storageId).pipe(
          Effect.provide(
            storageDeleteDatabase({
              deleting: false,
              references: 1,
            })
          )
        )
      )
    ).rejects.toThrow("still contains cataloged backups")
    expect(vi.mocked(deleteS3BackupPrefix)).not.toHaveBeenCalled()
  })

  it("keeps deleting after a prefix purge failure", async () => {
    vi.mocked(deleteS3BackupPrefix).mockReturnValueOnce(
      Effect.fail(
        BackupStorageError.make({
          code: "s3_request_failed",
          operation: "storage.deletePrefix",
          reason: "The S3-compatible storage request failed",
        })
      )
    )
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    await expect(
      Effect.runPromise(
        deleteBackupStorageEffect(storageId).pipe(
          Effect.provide(
            storageDeleteDatabase({
              deleting: false,
              references: 0,
              writes,
            })
          )
        )
      )
    ).rejects.toThrow("S3-compatible storage request failed")
    expect(writes.some((write) => write.sql.includes("deleting = TRUE"))).toBe(
      true
    )
    expect(writes.some((write) => write.sql.includes("last_error"))).toBe(true)
    expect(
      writes.some((write) => write.sql.includes("DELETE FROM") && write.sql.includes("backup_storage"))
    ).toBe(false)
  })

  it("purges restic prefixes then removes the destination", async () => {
    vi.mocked(deleteS3BackupPrefix).mockReturnValue(Effect.void)
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    await Effect.runPromise(
      deleteBackupStorageEffect(storageId).pipe(
        Effect.provide(
          storageDeleteDatabase({
            deleting: true,
            references: 0,
            writes,
          })
        )
      )
    )
    expect(vi.mocked(deleteS3BackupPrefix)).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKeyId: "AKIAEXAMPLE",
        bucket: "kiln-backups",
      }),
      repositoryPrefix
    )
    expect(
      writes.some(
        (write) =>
          write.sql.includes("DELETE FROM") &&
          write.sql.includes("backup_repository")
      )
    ).toBe(true)
    expect(
      writes.some(
        (write) =>
          write.sql.includes("DELETE FROM") &&
          write.sql.includes("backup_storage")
      )
    ).toBe(true)
  })
})

function storageDeleteDatabase(input: {
  deleting: boolean
  references: number
  writes?: Array<{ sql: string; values?: ReadonlyArray<unknown> }>
}) {
  const writes = input.writes ?? []
  return Layer.succeed(Database)({
    execute: (_operation, sql, values) =>
      Effect.sync(() => {
        writes.push({ sql, values })
        return emptyResult
      }),
    queryRows: <TRow extends RowDataPacket>(operation: string) =>
      Effect.sync(() => {
        if (operation === "backup_storage_credential") {
          return [storageCredentialRow(input.deleting)] as unknown as ReadonlyArray<TRow>
        }
        if (operation === "backup_storage_delete_repositories") {
          return [
            { id: "repo-one", object_prefix: repositoryPrefix },
          ] as unknown as ReadonlyArray<TRow>
        }
        throw new Error(`Unexpected query ${operation}`)
      }),
    transaction: (_operation, run) =>
      run({
        execute: (sql, values) =>
          Effect.sync(() => {
            writes.push({ sql, values })
            return emptyResult
          }),
        queryRows: <TRow extends RowDataPacket>(sql: string) =>
          Effect.sync(() => {
            if (sql.includes("reference_count")) {
              return [
                { reference_count: input.references },
              ] as unknown as ReadonlyArray<TRow>
            }
            return [storageIdentityRow(input.deleting)] as unknown as ReadonlyArray<TRow>
          }),
      }),
  })
}

function storageIdentityRow(deleting: boolean) {
  return {
    bucket: "kiln-backups",
    deleting: deleting ? 1 : 0,
    endpoint: "https://s3.example.com",
    force_path_style: 1,
    id: storageId,
    object_prefix: "team",
    owner_user_id: null,
    region: "us-east-1",
  }
}

function storageCredentialRow(deleting: boolean) {
  return {
    ...storageIdentityRow(deleting),
    access_key_id_ciphertext: "enc:AKIAEXAMPLE",
    allow_private_network: 1,
    created_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
    enabled: 1,
    last_error: null,
    last_verified_at_ms: null,
    name: "minio",
    secret_access_key_ciphertext: "enc:s3-secret",
  }
}
