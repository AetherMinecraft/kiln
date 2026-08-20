import { describe, expect, it } from "vite-plus/test"

import {
  backupDestinations,
  FULL_BACKUP_DESTINATION_OPERATIONS,
  RESTIC_DESTINATION_OPERATIONS,
} from "."

describe("backup destination registry", () => {
  it.each(Object.values(backupDestinations))(
    "$kind implements every declared destination standard",
    (destination) => {
      const full = destination.formats.full
      const restic = destination.formats.restic

      expect(full ?? restic).toBeTruthy()
      if (full) {
        expect(Object.keys(full).sort()).toEqual(
          [...FULL_BACKUP_DESTINATION_OPERATIONS].sort()
        )
      }
      if (restic) {
        expect(Object.keys(restic).sort()).toEqual(
          [...RESTIC_DESTINATION_OPERATIONS].sort()
        )
      }
    }
  )
})
