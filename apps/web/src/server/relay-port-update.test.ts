import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { relayInstanceSchema } from "@workspace/contracts"

const mocks = vi.hoisted(() => ({
  applyManagedDomainAddressesEffect: vi.fn(),
  invalidateRelayCache: vi.fn(),
  listPersistedRelays: vi.fn(),
  provisionInstanceDomainBestEffort: vi.fn(),
  relayFetchEffect: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
  requireRelayPermission: vi.fn(),
  runAppEffect: vi.fn(),
}))

vi.mock("@/effect/runtime", () => ({ runAppEffect: mocks.runAppEffect }))
vi.mock("@/lib/access-control", () => ({
  allowedInstanceIds: vi.fn(
    async (_user, _relayId, instanceIds) => new Set(instanceIds)
  ),
  requireRelayPermission: mocks.requireRelayPermission,
}))
vi.mock("@/lib/file-activity", () => ({
  listFileActivity: vi.fn(),
  recordFileEdited: vi.fn(),
  recordFileViewed: vi.fn(),
  setFilePinned: vi.fn(),
}))
vi.mock("@/lib/final-instance-deletion", () => ({
  deleteInstanceWithFinalBackup: vi.fn(),
}))
vi.mock("@/lib/relay-client", () => ({
  cachedRelayFallbackJsonEffect: vi.fn(),
  cachedRelayJsonEffect: vi.fn(),
  invalidateRelayCache: mocks.invalidateRelayCache,
  relayCachePolicy: { snapshot: vi.fn(() => "snapshot-policy") },
  relayFetchEffect: mocks.relayFetchEffect,
  relayJsonEffect: vi.fn(),
}))
vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: mocks.listPersistedRelays,
}))
vi.mock("@/server/auth", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}))
vi.mock("@/server/domains.server", () => ({
  applyManagedDomainAddressesEffect: mocks.applyManagedDomainAddressesEffect,
  provisionInstanceDomainBestEffort: mocks.provisionInstanceDomainBestEffort,
}))

import { updateInstancePortsHandler } from "./relay"

const relayId = "relay-one"
const instanceId = "2".repeat(40)
const updatedInstance = relayInstanceSchema.parse({
  brickNetworkMode: "direct",
  connectAddress: "port-update.test:32124",
  containerId: "port-update-container",
  desiredState: "stopped",
  directory: "2".repeat(40),
  game: "Minecraft",
  id: instanceId,
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
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invalidateRelayCache.mockReturnValue(Effect.void)
    mocks.listPersistedRelays.mockResolvedValue([
      { enabled: true, id: relayId },
    ])
    mocks.relayFetchEffect.mockReturnValue(
      Effect.succeed(Response.json(updatedInstance))
    )
    mocks.requireAuthenticatedUser.mockResolvedValue({ id: "user-one" })
    mocks.requireRelayPermission.mockResolvedValue(undefined)
    mocks.runAppEffect.mockImplementation((_name, effect) =>
      Effect.runPromise(effect)
    )
  })

  it("provisions the managed domain after a primary public-port replacement", async () => {
    await updateInstancePortsHandler({
      instanceId,
      ports: [
        {
          externalPort: 32_124,
          id: "primary",
          internalPort: 25_565,
          leaseId: "a".repeat(32),
          name: "Default Server",
          protocol: "tcp",
        },
      ],
      relayId,
    })

    expect(mocks.requireRelayPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "instance.network.public-port.write",
      })
    )
    expect(mocks.provisionInstanceDomainBestEffort).toHaveBeenCalledWith(
      updatedInstance,
      relayId
    )
  })

  it("does not resync the domain for a protocol-only edit", async () => {
    await updateInstancePortsHandler({
      instanceId,
      ports: [
        {
          id: "primary",
          internalPort: 25_565,
          name: "Default Server",
          protocol: "both",
        },
      ],
      relayId,
    })

    expect(mocks.provisionInstanceDomainBestEffort).not.toHaveBeenCalled()
  })
})
