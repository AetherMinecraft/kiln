import { createFileRoute } from "@tanstack/react-router"

import { SchedulesPage } from "@/components/schedules-page"
import { schedulesQueryOptions } from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/automations/schedules")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(schedulesQueryOptions())
  },
  head: () => ({ meta: [{ title: pageTitle("Schedules") }] }),
  component: SchedulesPage,
})
