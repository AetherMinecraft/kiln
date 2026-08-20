import {
  fullBackupDestinationStandard,
  resticDestinationStandard,
} from "../standards"
import { defineBackupDestination } from "../types"

export { prepareLocalBackupDownload, signLocalBackupDownload } from "./download"
export { localBackupDestinationTaskDriver } from "./task"

export const localBackupDestination = defineBackupDestination({
  formats: {
    full: fullBackupDestinationStandard,
    restic: resticDestinationStandard,
  },
  kind: "local",
  label: "Relay storage",
  persistence: "implicit",
})
