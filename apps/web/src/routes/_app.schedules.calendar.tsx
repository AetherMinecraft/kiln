import { createFileRoute } from "@tanstack/react-router"
import { CalendarDays } from "lucide-react"

import { SettingsPlaceholderPage } from "@/components/settings-placeholder-page"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/schedules/calendar")({
  head: () => ({ meta: [{ title: pageTitle("Schedule Calendar") }] }),
  component: ScheduleCalendarRoute,
})

function ScheduleCalendarRoute() {
  return (
    <SettingsPlaceholderPage
      title="Calendar"
      description="A calendar view of upcoming schedule runs will live here."
      icon={CalendarDays}
    />
  )
}
