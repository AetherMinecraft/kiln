import { createFileRoute } from "@tanstack/react-router"

import { SchedulesPage } from "@/components/schedules-page"
import {
  scheduleOptionsQueryOptions,
  schedulesQueryOptions,
} from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/schedules/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(schedulesQueryOptions()),
      context.queryClient.ensureQueryData(scheduleOptionsQueryOptions()),
    ])
  },
  head: () => ({ meta: [{ title: pageTitle("Schedules") }] }),
  component: SchedulesPage,
})
