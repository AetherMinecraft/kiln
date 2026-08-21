import { describe, expect, it } from "vite-plus/test"
import { relayControlProtocolVersion } from "@workspace/contracts"

import type { KilnReleaseManifest } from "@/effect/github-releases"
import {
  updateTargetVersion,
  validateUpdateManifest,
} from "@/lib/update-manifest"

const gitRepository = "https://github.com/kiln-site/kiln"
const manifest: KilnReleaseManifest = {
  channel: "nightly",
  commit: "a".repeat(40),
  compatibility: {
    relayProtocol: relayControlProtocolVersion,
  },
  components: {
    hearth: {
      digest: `sha256:${"b".repeat(64)}`,
      image: "ghcr.io/kiln-site/hearth",
    },
    relay: {
      digest: `sha256:${"c".repeat(64)}`,
      image: "ghcr.io/kiln-site/relay",
    },
  },
  publishedAt: "2026-07-24T00:00:00.000Z",
  schemaVersion: 1,
  version: "0.1.0-nightly.2",
}

describe("update manifest validation", () => {
  it("uses the baked alias when applying a migrated nightly", () => {
    expect(
      updateTargetVersion({
        ...manifest,
        imageVersion: "0.1.0-nightly.2",
        version: "0.1.0-nightly.20260725.162524",
      })
    ).toBe("0.1.0-nightly.2")
  })

  it("keeps the stable version when applying a promoted nightly image", () => {
    expect(
      updateTargetVersion({
        ...manifest,
        channel: "stable",
        imageVersion: "0.1.0-nightly.20260725.162524",
        version: "0.1.0",
      })
    ).toBe("0.1.0")
  })

  it("accepts the current Relay protocol", () => {
    expect(() =>
      validateUpdateManifest(
        manifest,
        "0.1.0-nightly.2",
        "relay",
        gitRepository
      )
    ).not.toThrow()
  })

  it("accepts images published by the configured fork owner", () => {
    const forkRepository = "https://github.com/Example/Kiln-Fork"
    expect(() =>
      validateUpdateManifest(
        {
          ...manifest,
          components: {
            hearth: {
              ...manifest.components.hearth,
              image: "ghcr.io/example/hearth",
            },
            relay: {
              ...manifest.components.relay,
              image: "ghcr.io/example/relay",
            },
          },
        },
        "0.1.0-nightly.2",
        "relay",
        forkRepository
      )
    ).not.toThrow()
  })

  it("rejects images from another repository owner", () => {
    expect(() =>
      validateUpdateManifest(
        manifest,
        "0.1.0-nightly.2",
        "relay",
        "https://github.com/example/kiln-fork"
      )
    ).toThrow("unexpected image")
  })

  it("accepts a legacy baked image version on the same release line", () => {
    expect(() =>
      validateUpdateManifest(
        {
          ...manifest,
          imageVersion: "0.1.0-nightly.2",
          version: "0.1.0-nightly.20260725.162524",
        },
        "0.1.0-nightly.20260725.162524",
        "relay",
        gitRepository
      )
    ).not.toThrow()
  })

  it("rejects a baked image version from another release line", () => {
    expect(() =>
      validateUpdateManifest(
        {
          ...manifest,
          imageVersion: "0.1.1-nightly.2",
          version: "0.1.0-nightly.20260725.162524",
        },
        "0.1.0-nightly.20260725.162524",
        "relay",
        gitRepository
      )
    ).toThrow("image version is invalid")
  })

  it("blocks a Relay-first update across a protocol transition", () => {
    expect(() =>
      validateUpdateManifest(
        {
          ...manifest,
          compatibility: {
            relayProtocol: relayControlProtocolVersion - 1,
          },
        },
        "0.1.0-nightly.2",
        "relay",
        gitRepository
      )
    ).toThrow(`requires Relay protocol ${relayControlProtocolVersion - 1}`)
  })

  it("allows a Hearth-first update across a protocol transition", () => {
    expect(() =>
      validateUpdateManifest(
        {
          ...manifest,
          compatibility: {
            relayProtocol: relayControlProtocolVersion - 1,
          },
        },
        "0.1.0-nightly.2",
        "hearth",
        gitRepository
      )
    ).not.toThrow()
  })
})
