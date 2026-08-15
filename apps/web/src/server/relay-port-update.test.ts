import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { relayInstanceSchema } from "@workspace/contracts"

const provisionInstanceDomainBestEffort = vi.hoisted(() => vi.fn())

vi.mock("@/server/domains.server", () => ({
  provisionInstanceDomainBestEffort,
}))

import { syncInstanceDomainAfterPortUpdateBestEffort } from "./relay-port-update.server"

const relayId = "relay-one"
const instance = relayInstanceSchema.parse({
  brickNetworkMode: "direct",
  connectAddress: "port-update.test:32124",
  containerId: "port-update-container",
  desiredState: "stopped",
  directory: "2".repeat(40),
  game: "Minecraft",
  id: "2".repeat(40),
  implementation: "Paper",
  javaVersion: "21",
  managedByRelay: true,
  name: "Port update server",
  observedState: "stopped",
  ports: [
    {
      externalPort: 32_124,
      id: "primary",
      internalPort: 25_565,
      kind: "primary",
      name: "Default Server",
      protocol: "tcp",
    },
  ],
  publicHost: "port-update.test",
  publicPort: 32_124,
  service: "kiln-port-update",
  shortId: "22222222",
  startedAt: null,
  status: "created",
  version: "1.21.11",
})

describe("instance port update domain sync", () => {
  beforeEach(() => provisionInstanceDomainBestEffort.mockClear())

  it("provisions the managed domain after a primary public-port replacement", async () => {
    await syncInstanceDomainAfterPortUpdateBestEffort(instance, relayId, [
      {
        externalPort: 32_124,
        id: "primary",
        internalPort: 25_565,
        leaseId: "a".repeat(32),
        name: "Default Server",
        protocol: "tcp",
      },
    ])

    expect(provisionInstanceDomainBestEffort).toHaveBeenCalledWith(
      instance,
      relayId
    )
  })

  it("does not resync the domain for a protocol-only edit", async () => {
    await syncInstanceDomainAfterPortUpdateBestEffort(instance, relayId, [
      {
        id: "primary",
        internalPort: 25_565,
        name: "Default Server",
        protocol: "both",
      },
    ])

    expect(provisionInstanceDomainBestEffort).not.toHaveBeenCalled()
  })
})
