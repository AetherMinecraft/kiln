import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  addBrickCatalogHandler,
  deleteBrickCatalogHandler,
  getBrickCatalogDetailsHandler,
  listBrickCatalogsHandler,
  setBrickCatalogCommunityHandler,
} from "@/server/brick-catalogs.server"

const catalogIdSchema = z.object({ catalogId: z.uuid() })
const catalogSourceSchema = z.object({
  source: z.string().trim().min(1).max(2_048),
})
const catalogVisibilitySchema = catalogIdSchema.extend({
  community: z.boolean(),
})

export const listBrickCatalogs = createServerFn({ method: "GET" }).handler(() =>
  listBrickCatalogsHandler()
)

export const getBrickCatalogDetails = createServerFn({ method: "GET" })
  .validator(z.object({ catalogId: z.string().min(1).max(36) }))
  .handler(({ data }) => getBrickCatalogDetailsHandler(data))

export const addBrickCatalog = createServerFn({ method: "POST" })
  .validator(catalogSourceSchema)
  .handler(({ data }) => addBrickCatalogHandler(data))

export const deleteBrickCatalog = createServerFn({ method: "POST" })
  .validator(catalogIdSchema)
  .handler(({ data }) => deleteBrickCatalogHandler(data))

export const setBrickCatalogCommunity = createServerFn({ method: "POST" })
  .validator(catalogVisibilitySchema)
  .handler(({ data }) => setBrickCatalogCommunityHandler(data))
