import { describe, expect, it } from "vite-plus/test"

import { catalogDisplayName, isVerifiedBrick } from "./brick-selector"
import { brickRecipeSchema, type Brick } from "@workspace/contracts"

const repository = "kiln-site/kiln"

describe("Brick catalog trust badges", () => {
  it("trusts commit-pinned recipes from the configured Kiln repository", () => {
    expect(
      isVerifiedBrick(
        brick(
          `https://raw.githubusercontent.com/${repository}/${"a".repeat(40)}/apps/bricks/recipes/paper.yml`,
          "Someone else"
        ),
        repository
      )
    ).toBe(true)
  })

  it("does not trust catalog-controlled author metadata", () => {
    expect(
      isVerifiedBrick(
        brick("https://example.com/malicious.yml", "Kiln"),
        repository
      )
    ).toBe(false)
  })
})

describe("Brick catalog names", () => {
  it("uses the catalog name when one is provided", () => {
    expect(
      catalogDisplayName({
        isDefault: false,
        name: "Cool Bricks",
        source: "https://github.com/cool-user/cool-bricks",
      })
    ).toBe("Cool Bricks")
  })

  it("names the default catalog Kiln", () => {
    expect(
      catalogDisplayName({
        isDefault: true,
        source:
          "https://raw.githubusercontent.com/kiln-site/kiln/main/apps/bricks/catalog.yml",
      })
    ).toBe("Kiln")
  })

  it("uses the owner and repository for GitHub catalogs", () => {
    expect(
      catalogDisplayName({
        isDefault: false,
        source:
          "https://raw.githubusercontent.com/cool-user/cool-bricks/abc123/catalog.yml",
      })
    ).toBe("cool-user/cool-bricks")
  })

  it("uses only the hostname for other catalogs", () => {
    expect(
      catalogDisplayName({
        isDefault: false,
        source: "https://coolbricks.com/catalogs/minecraft.yml",
      })
    ).toBe("coolbricks.com")
  })
})

function brick(source: string, author: string): Brick {
  return {
    source,
    ...brickRecipeSchema.parse({
      format: "kiln.brick/v1",
      metadata: {
        author,
        description: "Test recipe",
        game: "Minecraft",
        id: "paper",
        name: "Paper",
      },
      variables: {},
      runtime: {
        environment: {},
        image: "example.test/paper:latest",
        name: "Paper",
        resources: { memory: "1G", pids: 128 },
        storage: { mount: "/server" },
      },
      network: {
        mode: "direct",
        ports: [{ container: 25565, name: "game", protocol: "tcp" }],
        primaryPort: "game",
      },
    }),
  }
}
