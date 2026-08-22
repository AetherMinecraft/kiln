import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { AutomationsRouteOutlet } from "@/components/automations-layout"
import {
  relaySnapshotQueryOptions,
  scheduleOptionsQueryOptions,
} from "@/lib/query-options"

const scheduleSearchSchema = z.object({
  kind: z.enum(["database", "relay", "server"]).optional(),
  relay: z.string().max(120).optional(),
  run: z.string().max(128).optional(),
  runRelay: z.string().max(120).optional(),
  schedule: z.uuid().optional(),
  target: z.string().max(120).optional(),
})

export const Route = createFileRoute("/_app/automations")({
  validateSearch: scheduleSearchSchema,
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(scheduleOptionsQueryOptions()),
      context.queryClient.ensureQueryData(relaySnapshotQueryOptions()),
    ])
  },
  component: AutomationsRouteOutlet,
})
