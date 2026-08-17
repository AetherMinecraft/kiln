export type SystemUpdateProgress = {
  label: string
  percent: number
}

const progressByPhase: Readonly<Record<string, SystemUpdateProgress>> = {
  Preparing: { label: "Preparing update", percent: 5 },
  awaitingReload: { label: "Update complete", percent: 100 },
  completed: { label: "Update complete", percent: 100 },
  reconnecting: { label: "Reconnecting to Kiln", percent: 88 },
  "replace.inspectContainer": { label: "Checking container", percent: 10 },
  "replace.inspectImage": { label: "Checking image", percent: 10 },
  "replace.tagTarget": { label: "Preparing image", percent: 20 },
  "replace.stopCurrent": { label: "Stopping container", percent: 32 },
  "replace.renameCurrent": { label: "Swapping containers", percent: 44 },
  "replace.createTarget": { label: "Creating container", percent: 56 },
  "replace.connectNetwork": { label: "Connecting network", percent: 64 },
  "replace.startTarget": { label: "Starting container", percent: 76 },
  "replace.waitUntilHealthy": {
    label: "Waiting for health check",
    percent: 90,
  },
  "replace.removeBackup": { label: "Removing old container", percent: 96 },
}

export function systemUpdateProgress(
  phase: string | undefined,
  reconnecting: boolean
): SystemUpdateProgress {
  if (reconnecting) return progressByPhase.reconnecting
  return progressByPhase[phase ?? "Preparing"] ?? progressByPhase.Preparing
}
