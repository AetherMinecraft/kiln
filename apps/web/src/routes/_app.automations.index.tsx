import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/automations/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/automations/schedules", search, replace: true })
  },
})
