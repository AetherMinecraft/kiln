export type SystemUpdateProgress = {
  label: string
  percent: number
}

const progressByPhase: Readonly<Record<string, SystemUpdateProgress>> = {
  Preparing: { label: "Preparing", percent: 5 },
  awaitingReload: { label: "Updated", percent: 100 },
  reconnecting: { label: "Reconnecting", percent: 88 },
  "replace.inspectContainer": { label: "Checking", percent: 10 },
  "replace.inspectImage": { label: "Checking", percent: 10 },
  "replace.tagTarget": { label: "Preparing", percent: 20 },
  "replace.stopCurrent": { label: "Stopping", percent: 32 },
  "replace.renameCurrent": { label: "Swapping", percent: 44 },
  "replace.createTarget": { label: "Creating", percent: 56 },
  "replace.connectNetwork": { label: "Connecting", percent: 64 },
  "replace.startTarget": { label: "Starting", percent: 76 },
  "replace.waitUntilHealthy": { label: "Checking", percent: 90 },
  "replace.removeBackup": { label: "Cleaning up", percent: 96 },
}

export function systemUpdateProgress(
  phase: string | undefined,
  reconnecting: boolean
): SystemUpdateProgress {
  if (reconnecting) return progressByPhase.reconnecting
  return progressByPhase[phase ?? "Preparing"] ?? progressByPhase.Preparing
}
