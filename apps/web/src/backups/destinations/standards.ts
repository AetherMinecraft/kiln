import type {
  FullBackupDestinationStandard,
  ResticDestinationStandard,
} from "./types"

export const fullBackupDestinationStandard = {
  check: true,
  delete: true,
  download: true,
  read: true,
  restore: true,
  save: true,
} as const satisfies FullBackupDestinationStandard

export const resticDestinationStandard = {
  backup: true,
  check: true,
  delete: true,
  download: true,
  prune: true,
  restore: true,
} as const satisfies ResticDestinationStandard
