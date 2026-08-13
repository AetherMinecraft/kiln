import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  npmUpdateCommand,
  updateCliEffect,
  type CliUpdateCommand,
} from "./update.js"

describe("CLI update", () => {
  it.effect("reinstalls the latest CLI package globally with npm", () =>
    Effect.gen(function* () {
      let received: CliUpdateCommand | null = null

      yield* updateCliEffect(async (command) => {
        received = command
      })

      assert.deepStrictEqual(received, {
        arguments: ["install", "--global", "kiln-cli@latest"],
        executable: process.platform === "win32" ? "npm.cmd" : "npm",
      })
    })
  )

  it.effect("reports npm failures as CLI update errors", () =>
    Effect.gen(function* () {
      const failure = yield* updateCliEffect(async () => {
        throw new Error("permission denied")
      }).pipe(Effect.flip)

      assert.strictEqual(failure.code, "cli_update_failed")
      assert.strictEqual(failure.message, "npm could not update the Kiln CLI.")
    })
  )

  it("uses the Windows npm executable on Windows", () => {
    assert.strictEqual(npmUpdateCommand("win32").executable, "npm.cmd")
  })
})
