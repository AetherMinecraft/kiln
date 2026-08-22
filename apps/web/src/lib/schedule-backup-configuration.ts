import type { ScheduleActionType } from "@workspace/contracts"

type ScheduleBackupTarget = {
  canCreate: boolean
  canUpdate: boolean
  kind: "database" | "instance" | "relay"
  permittedActions: ReadonlyArray<ScheduleActionType>
}

export function scheduleBackupAllowsIncremental(
  targets: ReadonlyArray<ScheduleBackupTarget>,
  permission: "canCreate" | "canUpdate"
) {
  return targets.some(
    (target) =>
      target.kind === "instance" &&
      target[permission] &&
      target.permittedActions.includes("backup")
  )
}

export function scheduleBackupDestination(
  mode: "full" | "incremental",
  destinationKey: string | undefined
): { kind: "local" } | { kind: "storage"; storageId: string } {
  if (
    mode === "full" ||
    destinationKey === undefined ||
    destinationKey === "default" ||
    destinationKey === "local"
  ) {
    return { kind: "local" }
  }
  return { kind: "storage", storageId: destinationKey }
}
