import { describe, expect, it } from "vite-plus/test"

import {
  dockerMemoryBytes,
  managedJavaStartupFlags,
} from "./managed-java-flags.js"

const paperEnv = {
  KILN_JAVA_MAX_RAM_PERCENTAGE: "75.0",
  MIN_RAM: "512M",
}

describe("managed Java startup flags", () => {
  it("shows a 75% heap from container memory and --nogui", () => {
    expect(managedJavaStartupFlags(paperEnv, "2G")).toBe(
      "-Xms512M -Xmx1536M --nogui"
    )
    expect(managedJavaStartupFlags(paperEnv, "4G")).toBe(
      "-Xms512M -Xmx3G --nogui"
    )
  })

  it("omits --nogui when the recipe clears server arguments", () => {
    expect(
      managedJavaStartupFlags(
        { ...paperEnv, KILN_SERVER_ARGS: "" },
        "1G"
      )
    ).toBe("-Xms512M -Xmx768M")
  })

  it("uses MAX_RAM when the recipe pins an explicit heap", () => {
    expect(
      managedJavaStartupFlags(
        { ...paperEnv, MAX_RAM: "1800M" },
        "4G"
      )
    ).toBe("-Xms512M -Xmx1800M --nogui")
  })

  it("falls back to MaxRAMPercentage when memory is not a Docker size", () => {
    expect(managedJavaStartupFlags(paperEnv, "plenty")).toBe(
      "-Xms512M -XX:MaxRAMPercentage=75 --nogui"
    )
  })

  it("parses Docker memory amounts", () => {
    expect(dockerMemoryBytes("2G")).toBe(2 * 1024 ** 3)
    expect(dockerMemoryBytes("512M")).toBe(512 * 1024 ** 2)
    expect(dockerMemoryBytes("nope")).toBeNull()
  })
})
