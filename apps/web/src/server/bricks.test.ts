import { builtinTailscaleBrick } from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

import {
  hearthCreateInstanceInputSchema,
  hearthUpdateInstanceStartupInputSchema,
  isBrickSourceChange,
} from "@/server/bricks"

const { source, ...recipeDefinition } = builtinTailscaleBrick

describe("Hearth Brick mutation inputs", () => {
  it("keeps same-source Startup saves pinned to the stored snapshot", () => {
    expect(isBrickSourceChange(source, source)).toBe(false)
    expect(isBrickSourceChange(source, undefined)).toBe(false)
    expect(isBrickSourceChange(source, "https://example.com/other.yml")).toBe(
      true
    )
  })

  it("rejects browser-supplied recipes during server creation", () => {
    const parsed = hearthCreateInstanceInputSchema.safeParse({
      name: "Example",
      recipe: source,
      recipeDefinition,
      relayId: "a".repeat(43),
      variables: {},
    })

    expect(parsed.success).toBe(false)
  })

  it("rejects browser-supplied recipes during startup updates", () => {
    const parsed = hearthUpdateInstanceStartupInputSchema.safeParse({
      instanceId: "b".repeat(40),
      recipe: source,
      recipeDefinition,
      relayId: "a".repeat(43),
      variables: {},
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "Brick definitions are resolved by Hearth",
            path: ["recipeDefinition"],
          }),
        ])
      )
    }
  })
})
