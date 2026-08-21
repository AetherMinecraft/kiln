import { createFileRoute } from "@tanstack/react-router"

import { ScheduleHistoryPage } from "@/components/schedules-page"
import { schedulesQueryOptions } from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/schedules/history")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(schedulesQueryOptions())
  },
  head: () => ({ meta: [{ title: pageTitle("Schedule History") }] }),
  component: ScheduleHistoryPage,
})
