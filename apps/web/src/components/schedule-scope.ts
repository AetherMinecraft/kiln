import * as React from "react"

import type { ServerPickerOption } from "@/components/server-picker-list"

export const ScheduleScopeContext =
  React.createContext<ServerPickerOption | null>(null)

export function useScheduleScope() {
  return React.useContext(ScheduleScopeContext)
}
