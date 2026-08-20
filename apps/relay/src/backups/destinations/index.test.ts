import { describe, expect, it } from "vite-plus/test"

import { backupDestinationFor } from "./index.js"

describe("backup destination drivers", () => {
  it.each(["local", "s3"] as const)(
    "%s supports full and restic backups",
    (kind) => {
      expect(backupDestinationFor(kind).capabilities).toEqual({
        full: true,
        restic: true,
      })
    }
  )
})
