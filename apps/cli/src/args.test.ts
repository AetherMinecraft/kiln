import { describe, expect, it } from "vite-plus/test"

import { parseArguments } from "./args.js"

describe("CLI arguments", () => {
  it("parses a command with ordinary defaults", () => {
    expect(parseArguments(["servers", "list"])).toMatchObject({
      command: ["servers", "list"],
      follow: false,
      limit: 2_000,
    })
  })

  it("supports command flags in any position", () => {
    expect(
      parseArguments([
        "--profile=automation",
        "server",
        "logs",
        "relay:instance",
        "--follow",
        "--limit",
        "500",
      ])
    ).toMatchObject({
      command: ["server", "logs", "relay:instance"],
      follow: true,
      limit: 500,
      profile: "automation",
    })
  })

  it("rejects unknown options and unsafe limits", () => {
    expect(() => parseArguments(["--unknown"])).toThrow("Unknown option")
    expect(() => parseArguments(["--limit", "10001"])).toThrow(
      "--limit must be"
    )
  })

  it("parses file sync options and rejects removed output flags", () => {
    expect(
      parseArguments([
        "files",
        "sync",
        "relay:instance",
        "./server",
        "--plan",
        "--json",
        "--exclude",
        "logs/**",
        "--exclude=*.tmp",
        "--atomic",
        "--delete-managed",
        "--manifest=managed.json",
        "--max-delete",
        "4",
        "--staging-path=.kiln/deployments",
      ])
    ).toMatchObject({
      command: ["files", "sync", "relay:instance", "./server"],
      atomic: true,
      deleteManaged: true,
      excludes: ["logs/**", "*.tmp"],
      json: true,
      manifest: "managed.json",
      maxDelete: 4,
      plan: true,
      stagingPath: ".kiln/deployments",
    })
    expect(() => parseArguments(["--output", "human"])).toThrow(
      "Unknown option: --output"
    )
    expect(() => parseArguments(["servers", "list", "--json"])).toThrow(
      "only supported by `kiln files sync`"
    )
    expect(() => parseArguments(["files", "read", "server", "--raw"])).toThrow(
      "Unknown option: --raw"
    )
  })

  it("parses server creation and startup options", () => {
    expect(
      parseArguments([
        "servers",
        "create",
        "relay-id",
        "paper",
        "--name",
        "Survival",
        "--disk=25GiB",
        "--memory",
        "4GiB",
        "--java-version=21",
        "--game-version",
        "1.21.11",
        "--variable",
        "online_mode=json:false",
        "--no-start",
      ])
    ).toMatchObject({
      command: ["servers", "create", "relay-id", "paper"],
      disk: "25GiB",
      gameVersion: "1.21.11",
      javaVersion: "21",
      memory: "4GiB",
      name: "Survival",
      start: false,
      variables: ["online_mode=json:false"],
    })
  })

  it("parses backup destination and restore safety options", () => {
    expect(
      parseArguments([
        "backups",
        "create",
        "server",
        "relay:instance",
        "--storage",
        "local",
        "--mode",
        "full",
        "--no-safety-backup",
      ])
    ).toMatchObject({
      command: ["backups", "create", "server", "relay:instance"],
      mode: "full",
      safetyBackup: false,
      storage: "local",
    })
    expect(() =>
      parseArguments([
        "backups",
        "create",
        "server",
        "relay:instance",
        "--mode",
        "zip",
      ])
    ).toThrow("--mode must be full or incremental")
  })
})
