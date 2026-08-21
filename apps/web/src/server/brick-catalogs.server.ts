import {
  deleteBrickCatalogEffect,
  getBrickCatalogEffect,
  listBrickCatalogsEffect,
  saveBrickCatalogEffect,
  setBrickCatalogVisibilityEffect,
} from "@/effect/brick-catalogs"
import type { BrickCatalogRecord } from "@/effect/brick-catalogs"
import { isPlatformAdmin } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { loadBrickCatalogSource } from "@/lib/brick-catalog-source.server"
import { kilnBrickCatalogUrl } from "@/lib/environment"
import { runAppEffect } from "@/effect/runtime"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { requireAuthenticatedUser } from "@/server/auth"
import { Effect } from "effect"

const DEFAULT_CATALOG_ID = "default"
const DEFAULT_CACHE_TTL_MS = 5 * 60_000

export interface BrickCatalogSummary {
  brickCount: number
  id: string
  isDefault: boolean
  ownerEmail: string | null
  ownerName: string | null
  ownerUserId: string | null
  publishedAt: string | null
  revisionSha: string | null
  revisionUrl: string | null
  snapshotSha256: string | null
  source: string
  statusError: string | null
  updatedAt: string | null
  visibility: "community" | "default" | "personal"
}

export async function listBrickCatalogsHandler() {
  const user = await requireAuthenticatedUser()
  const platformAdmin = isPlatformAdmin(user)
  const [defaultResult, records] = await Promise.all([
    loadDefaultCatalogResult(),
    runAppEffect(
      "brickCatalogs.list",
      listBrickCatalogsEffect(user.id, platformAdmin)
    ),
  ])
  return {
    catalogs: [
      defaultSummary(defaultResult.catalog, defaultResult.error),
      ...records.map((catalog) => catalogSummary(catalog, platformAdmin)),
    ],
    isPlatformAdmin: platformAdmin,
    userId: user.id,
  }
}

export async function getBrickCatalogDetailsHandler(data: {
  catalogId: string
}) {
  const user = await requireAuthenticatedUser()
  if (data.catalogId === DEFAULT_CATALOG_ID) {
    const catalog = await loadDefaultCatalog()
    return {
      ...defaultSummary(catalog, null),
      bricks: catalog.snapshot.bricks,
    }
  }
  const catalog = await requiredCatalog(data.catalogId)
  requireCatalogView(user, catalog)
  return {
    ...catalogSummary(catalog, isPlatformAdmin(user)),
    bricks: catalog.snapshot.bricks,
  }
}

export async function addBrickCatalogHandler(data: { source: string }) {
  const user = await requireAuthenticatedUser()
  const loaded = await loadBrickCatalogSource(data.source)
  const catalogId = await runAppEffect(
    "brickCatalogs.save",
    saveBrickCatalogEffect({
      ownerUserId: user.id,
      revisionSha: loaded.revisionSha,
      revisionUrl: loaded.revisionUrl,
      snapshot: loaded.snapshot,
      snapshotSha256: loaded.snapshotSha256,
      source: loaded.source,
    })
  )
  return catalogSummary(await requiredCatalog(catalogId), isPlatformAdmin(user))
}

export async function deleteBrickCatalogHandler(data: { catalogId: string }) {
  const user = await requireAuthenticatedUser()
  const catalog = await requiredCatalog(data.catalogId)
  if (!isPlatformAdmin(user) && catalog.ownerUserId !== user.id) {
    throw new Error("You do not have access to this catalog")
  }
  if (!isPlatformAdmin(user) && catalog.visibility === "community") {
    throw new Error("A platform admin must unpublish this catalog first")
  }
  await runAppEffect(
    "brickCatalogs.delete",
    deleteBrickCatalogEffect(catalog.id)
  )
  return { deleted: true }
}

export async function setBrickCatalogCommunityHandler(data: {
  catalogId: string
  community: boolean
}) {
  const user = await requireAuthenticatedUser()
  if (!isPlatformAdmin(user)) {
    throw new Error("Only platform admins can publish catalogs")
  }
  await requiredCatalog(data.catalogId)
  const updated = await runAppEffect(
    "brickCatalogs.setVisibility",
    setBrickCatalogVisibilityEffect({
      catalogId: data.catalogId,
      community: data.community,
      publishedBy: user.id,
    })
  )
  if (!updated) throw new Error("Catalog not found")
  return catalogSummary(await requiredCatalog(data.catalogId), true)
}

export async function visibleBrickCatalogs(user: AuthenticatedUser) {
  const [defaultCatalog, records] = await Promise.all([
    recoverPromise(
      () => loadDefaultCatalog(),
      () => null
    ),
    runAppEffect(
      "brickCatalogs.visible",
      listBrickCatalogsEffect(user.id, false)
    ),
  ])
  return [
    ...(defaultCatalog ? [defaultCatalog.snapshot] : []),
    ...records.map((record) => record.snapshot),
  ]
}

async function requiredCatalog(catalogId: string): Promise<BrickCatalogRecord> {
  const catalog = await runAppEffect(
    "brickCatalogs.get",
    getBrickCatalogEffect(catalogId)
  )
  if (!catalog) throw new Error("Catalog not found")
  return catalog
}

function requireCatalogView(
  user: AuthenticatedUser,
  catalog: BrickCatalogRecord
): void {
  if (
    catalog.visibility !== "community" &&
    catalog.ownerUserId !== user.id &&
    !isPlatformAdmin(user)
  ) {
    throw new Error("You do not have access to this catalog")
  }
}

function catalogSummary(
  catalog: BrickCatalogRecord,
  includeOwnerDetails: boolean
): BrickCatalogSummary {
  return {
    brickCount: catalog.snapshot.bricks.length,
    id: catalog.id,
    isDefault: false,
    ownerEmail: includeOwnerDetails ? catalog.ownerEmail : null,
    ownerName: includeOwnerDetails ? catalog.ownerName : null,
    ownerUserId: catalog.ownerUserId,
    publishedAt: catalog.publishedAt,
    revisionSha: catalog.revisionSha,
    revisionUrl: catalog.revisionUrl,
    snapshotSha256: catalog.snapshotSha256,
    source: catalog.source,
    statusError: null,
    updatedAt: catalog.updatedAt,
    visibility: catalog.visibility,
  }
}

function defaultSummary(
  catalog: Awaited<ReturnType<typeof loadDefaultCatalog>> | null,
  error: string | null
): BrickCatalogSummary {
  return {
    brickCount: catalog?.snapshot.bricks.length ?? 0,
    id: DEFAULT_CATALOG_ID,
    isDefault: true,
    ownerEmail: null,
    ownerName: null,
    ownerUserId: null,
    publishedAt: null,
    revisionSha: catalog?.revisionSha ?? null,
    revisionUrl: catalog?.revisionUrl ?? null,
    snapshotSha256: catalog?.snapshotSha256 ?? null,
    source: catalog?.source ?? kilnBrickCatalogUrl(),
    statusError: error,
    updatedAt: null,
    visibility: "default",
  }
}

let defaultCatalogCache:
  | {
      expiresAt: number
      value: Awaited<ReturnType<typeof loadBrickCatalogSource>>
    }
  | undefined

async function loadDefaultCatalog() {
  if (defaultCatalogCache && defaultCatalogCache.expiresAt > Date.now()) {
    return defaultCatalogCache.value
  }
  return Effect.runPromise(
    promiseEffect(() =>
      loadBrickCatalogSource(kilnBrickCatalogUrl(), { allowFile: true })
    ).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          defaultCatalogCache = {
            expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
            value,
          }
        })
      ),
      Effect.catch((cause) =>
        defaultCatalogCache
          ? Effect.succeed(defaultCatalogCache.value)
          : Effect.fail(cause)
      )
    )
  )
}

function loadDefaultCatalogResult() {
  return Effect.runPromise(
    promiseEffect(() => loadDefaultCatalog()).pipe(
      Effect.match({
        onFailure: (cause) => ({
          catalog: null,
          error:
            cause instanceof Error
              ? cause.message
              : "Default catalog is unavailable",
        }),
        onSuccess: (catalog) => ({ catalog, error: null }),
      })
    )
  )
}
