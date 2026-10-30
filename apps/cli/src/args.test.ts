import { describe, expect, it } from "vite-plus/test"

import { parseArguments } from "./args.js"

describe("CLI arguments", () => {
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
})
