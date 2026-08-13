import { describe, expect, it } from "vite-plus/test"

import { selectBackupCopySource } from "./backup-copy-source"

describe("backup copy source selection", () => {
  it("prefers an available S3 replica over the Relay-local artifact", () => {
    const local = { id: "local", status: "available", storageId: null }
    const remote = {
      id: "remote",
      status: "available",
      storageId: "storage-one",
    }

    expect(selectBackupCopySource([local, remote])).toBe(remote)
  })

  it("falls back to the available Relay-local artifact", () => {
    const local = { id: "local", status: "available", storageId: null }
    const failedRemote = {
      id: "remote",
      status: "failed",
      storageId: "storage-one",
    }

    expect(selectBackupCopySource([failedRemote, local])).toBe(local)
    expect(selectBackupCopySource([failedRemote])).toBeUndefined()
  })
})
