import { createFileRoute, redirect } from "@tanstack/react-router"
import { z } from "zod"

import { BackupDownloadPage } from "@/components/backup-download-page"
import { pageTitle } from "@/lib/page-title"
import { getBackupDownloadShare } from "@/server/backup-downloads"

export const Route = createFileRoute("/downloads/$id")({
  validateSearch: z.object({
    direct: z.union([z.literal(true), z.literal("true")]).optional(),
  }),
  loaderDeps: ({ search }) => ({ direct: Boolean(search.direct) }),
  loader: async ({ deps, params }) => {
    const share = /^[A-Za-z\d_-]{16}$/u.test(params.id)
      ? await getBackupDownloadShare({ data: { id: params.id } })
      : null
    if (deps.direct && share) throw redirect({ href: share.downloadUrl })
    return share
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: pageTitle(loaderData?.filename ?? "Download") },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: BackupDownloadRoute,
})

function BackupDownloadRoute() {
  return (
    <BackupDownloadPage
      downloadId={Route.useParams().id}
      share={Route.useLoaderData()}
    />
  )
}
