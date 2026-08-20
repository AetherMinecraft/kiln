import { describe, expect, it, vi } from "vite-plus/test"

import { resolveBackupRelayForOperation } from "./relay"

describe("backup Relay requirements", () => {
  it("always resolves the Relay used to cancel a backup task", async () => {
    const loadRelay = vi.fn(async (relayId: string) => ({ id: relayId }))

    await expect(
      resolveBackupRelayForOperation(
        { operation: "cancel", relayId: "relay-one" },
        loadRelay
      )
    ).resolves.toEqual({ id: "relay-one" })
    expect(loadRelay).toHaveBeenCalledExactlyOnceWith("relay-one")
  })

  it("only resolves a Relay for local archive downloads", async () => {
    const loadRelay = vi.fn(async (relayId: string) => ({ id: relayId }))

    await expect(
      resolveBackupRelayForOperation(
        {
          operation: "download",
          relayId: "relay-one",
          storageId: null,
        },
        loadRelay
      )
    ).resolves.toEqual({ id: "relay-one" })
    await expect(
      resolveBackupRelayForOperation(
        {
          operation: "download",
          relayId: "relay-one",
          storageId: "storage-one",
        },
        loadRelay
      )
    ).resolves.toBeNull()
    expect(loadRelay).toHaveBeenCalledExactlyOnceWith("relay-one")
  })
})
