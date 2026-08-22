import { createFileRoute } from "@tanstack/react-router"
import { RefreshCw } from "lucide-react"

import { SettingsPlaceholderPage } from "@/components/settings-placeholder-page"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/automations/sync")({
  head: () => ({ meta: [{ title: pageTitle("Automation Sync") }] }),
  component: AutomationSyncRoute,
})

function AutomationSyncRoute() {
  return (
    <SettingsPlaceholderPage
      title="Sync"
      description="Automation sync tools will live here."
      icon={RefreshCw}
    />
  )
}
