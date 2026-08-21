import { createHash, randomUUID } from "node:crypto"

import { relayCatalogSchema } from "@workspace/contracts"
import type { RelayCatalog } from "@workspace/contracts"
import { Effect, Result } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

export const PERSONAL_CATALOG_LIMIT = 10

interface CatalogRow extends RowDataPacket {
  id: string
  owner_email: string | null
  owner_name: string | null
  owner_user_id: string
  published_at: Date | null
  published_by: string | null
  revision_sha: string | null
  revision_url: string | null
  snapshot: unknown
  snapshot_sha256: string
  source: string
  updated_at: Date
  visibility: "community" | "personal"
}

export interface BrickCatalogRecord {
  id: string
  ownerEmail: string | null
  ownerName: string | null
  ownerUserId: string
  publishedAt: string | null
  publishedBy: string | null
  revisionSha: string | null
  revisionUrl: string | null
  snapshot: RelayCatalog
  snapshotSha256: string
  source: string
  updatedAt: string
  visibility: "community" | "personal"
}

export const listBrickCatalogsEffect = Effect.fn("brickCatalogs.list")(
  function* (userId: string, includeAll: boolean) {
    const database = yield* Database
    const rows = yield* database.queryRows<CatalogRow>(
      "brickCatalogs.list",
      `SELECT catalog.id, catalog.owner_user_id, catalog.source,
              catalog.snapshot, catalog.snapshot_sha256,
              catalog.revision_sha, catalog.revision_url,
              catalog.visibility, catalog.published_by,
              catalog.published_at, catalog.updated_at,
              auth_user.name AS owner_name,
              auth_user.email AS owner_email
         FROM ${databaseTable("brick_catalog")} catalog
         LEFT JOIN ${databaseTable("user")} auth_user
           ON auth_user.id = catalog.owner_user_id
        ${includeAll ? "" : "WHERE catalog.visibility = 'community' OR catalog.owner_user_id = ?"}
        ORDER BY catalog.visibility = 'community' DESC,
                 catalog.updated_at DESC`,
      includeAll ? [] : [userId]
    )
    return rows.flatMap(decodeCatalogRow)
  }
)

export const getBrickCatalogEffect = Effect.fn("brickCatalogs.get")(function* (
  catalogId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<CatalogRow>(
    "brickCatalogs.get",
    `SELECT catalog.id, catalog.owner_user_id, catalog.source,
              catalog.snapshot, catalog.snapshot_sha256,
              catalog.revision_sha, catalog.revision_url,
              catalog.visibility, catalog.published_by,
              catalog.published_at, catalog.updated_at,
              auth_user.name AS owner_name,
              auth_user.email AS owner_email
         FROM ${databaseTable("brick_catalog")} catalog
         LEFT JOIN ${databaseTable("user")} auth_user
           ON auth_user.id = catalog.owner_user_id
        WHERE catalog.id = ?
        LIMIT 1`,
    [catalogId]
  )
  return rows.flatMap(decodeCatalogRow)[0] ?? null
})

export const saveBrickCatalogEffect = Effect.fn("brickCatalogs.save")(
  function* (input: {
    ownerUserId: string
    revisionSha: string | null
    revisionUrl: string | null
    snapshot: RelayCatalog
    snapshotSha256: string
    source: string
  }) {
    const database = yield* Database
    const sourceHash = createHash("sha256").update(input.source).digest("hex")
    const id = randomUUID()
    return yield* database.transaction("brickCatalogs.save", (transaction) =>
      Effect.gen(function* () {
        const existing = yield* transaction.queryRows<CatalogRow>(
          `SELECT catalog.id, catalog.owner_user_id, catalog.source,
                  catalog.snapshot, catalog.snapshot_sha256,
                  catalog.revision_sha, catalog.revision_url,
                  catalog.visibility, catalog.published_by,
                  catalog.published_at, catalog.updated_at,
                  NULL AS owner_name, NULL AS owner_email
             FROM ${databaseTable("brick_catalog")} catalog
            WHERE catalog.owner_user_id = ? AND catalog.source_hash = ?
            LIMIT 1 FOR UPDATE`,
          [input.ownerUserId, sourceHash]
        )
        const current = existing.flatMap(decodeCatalogRow)[0]
        if (current?.visibility === "community") {
          return yield* Effect.fail(
            new Error("Unpublish this catalog before replacing its snapshot")
          )
        }
        if (!current) {
          const counts = yield* transaction.queryRows<
            RowDataPacket & { total: number }
          >(
            `SELECT COUNT(*) AS total
               FROM ${databaseTable("brick_catalog")}
              WHERE owner_user_id = ?`,
            [input.ownerUserId]
          )
          if ((counts[0]?.total ?? 0) >= PERSONAL_CATALOG_LIMIT) {
            return yield* Effect.fail(
              new Error(
                `Each account can save up to ${PERSONAL_CATALOG_LIMIT} catalogs`
              )
            )
          }
        }
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("brick_catalog")}
             (id, owner_user_id, source_hash, source, snapshot,
              snapshot_sha256, revision_sha, revision_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             snapshot = VALUES(snapshot),
             snapshot_sha256 = VALUES(snapshot_sha256),
             revision_sha = VALUES(revision_sha),
             revision_url = VALUES(revision_url),
             updated_at = CURRENT_TIMESTAMP(3)`,
          [
            id,
            input.ownerUserId,
            sourceHash,
            input.source,
            JSON.stringify(input.snapshot),
            input.snapshotSha256,
            input.revisionSha,
            input.revisionUrl,
          ]
        )
        return current?.id ?? id
      })
    )
  }
)

export const setBrickCatalogVisibilityEffect = Effect.fn(
  "brickCatalogs.setVisibility"
)(function* (input: {
  catalogId: string
  community: boolean
  publishedBy: string
}) {
  const database = yield* Database
  const result = yield* database.execute(
    "brickCatalogs.setVisibility",
    `UPDATE ${databaseTable("brick_catalog")}
        SET visibility = ?,
            published_by = ?,
            published_at = ?
      WHERE id = ?`,
    input.community
      ? ["community", input.publishedBy, new Date(), input.catalogId]
      : ["personal", null, null, input.catalogId]
  )
  return result.affectedRows > 0
})

export const deleteBrickCatalogEffect = Effect.fn("brickCatalogs.delete")(
  function* (catalogId: string) {
    const database = yield* Database
    const result = yield* database.execute(
      "brickCatalogs.delete",
      `DELETE FROM ${databaseTable("brick_catalog")} WHERE id = ?`,
      [catalogId]
    )
    return result.affectedRows > 0
  }
)

function decodeCatalogRow(row: CatalogRow): Array<BrickCatalogRecord> {
  const snapshot = relayCatalogSchema.safeParse(decodeJson(row.snapshot))
  return snapshot.success
    ? [
        {
          id: row.id,
          ownerEmail: row.owner_email,
          ownerName: row.owner_name,
          ownerUserId: row.owner_user_id,
          publishedAt: row.published_at?.toISOString() ?? null,
          publishedBy: row.published_by,
          revisionSha: row.revision_sha,
          revisionUrl: row.revision_url,
          snapshot: snapshot.data,
          snapshotSha256: row.snapshot_sha256,
          source: row.source,
          updatedAt: row.updated_at.toISOString(),
          visibility: row.visibility,
        },
      ]
    : []
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  return Result.getOrElse(
    Result.try(() => JSON.parse(value) as unknown),
    () => null
  )
}
