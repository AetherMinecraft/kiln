import { describe, expect, it } from "vite-plus/test"

import { replaceRelayUpdateVersion } from "./system-update-cache"

describe("system update cache", () => {
  it("updates only the relay that completed", () => {
    const relays = [
      { currentVersion: "0.1.0", relayId: "relay-a" },
      { currentVersion: "0.1.0", relayId: "relay-b" },
    ]

    expect(replaceRelayUpdateVersion(relays, "relay-a", "0.2.0")).toEqual([
      { currentVersion: "0.2.0", relayId: "relay-a" },
      { currentVersion: "0.1.0", relayId: "relay-b" },
    ])
  })
})
