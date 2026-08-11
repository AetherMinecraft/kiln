import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

const downloadIdSchema = z.object({
  id: z.string().regex(/^[A-Za-z\d_-]{16}$/u),
})

export const getBackupDownloadShare = createServerFn({ method: "GET" })
  .validator(downloadIdSchema)
  .handler(async ({ data }) => {
    const [
      crypto,
      { loadBackupDownloadShareEffect },
      { runAppEffect },
      { kilnPublicUrl },
    ] = await Promise.all([
      import("node:crypto"),
      import("@/effect/backup-download-shares"),
      import("@/effect/runtime"),
      import("@/lib/environment"),
    ])
    const { setResponseHeader } = await import("@tanstack/react-start/server")
    setResponseHeader("Cache-Control", "private, no-store")
    setResponseHeader("Referrer-Policy", "no-referrer")
    const share = await runAppEffect(
      "backups.downloadShares.get",
      loadBackupDownloadShareEffect(
        crypto.createHash("sha256").update(data.id).digest("hex")
      )
    )
    return share ? { ...share, homeUrl: kilnPublicUrl().toString() } : null
  })
