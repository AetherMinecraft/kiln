import {
  fullBackupDestinationStandard,
  resticDestinationStandard,
} from "../standards"
import { defineBackupDestination } from "../types"

export * from "./client"
export { prepareS3BackupDownload } from "./download"
export * from "./storage"
export { s3BackupDestinationTaskDriver } from "./task"

export const s3BackupDestination = defineBackupDestination({
  formats: {
    full: fullBackupDestinationStandard,
    restic: resticDestinationStandard,
  },
  kind: "s3",
  label: "S3-compatible storage",
  persistence: "configured",
})
