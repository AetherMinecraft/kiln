import { createFileRoute } from "@tanstack/react-router"

import { SchedulesRouteOutlet } from "@/components/schedules-layout"

export const Route = createFileRoute("/_app/schedules")({
  component: SchedulesRouteOutlet,
})
