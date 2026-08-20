import { assert, describe, layer } from "@effect/vitest"
import { builtinTailscaleBrick } from "@workspace/contracts"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"

import {
  listCustomBricksEffect,
  saveCustomBrickEffect,
} from "@/effect/custom-bricks"
import { Database } from "@/effect/database"

const emptyResult: ResultSetHeader = {
  affectedRows: 0,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

const statements: Array<{
  operation: string
  sql: string
  values: ReadonlyArray<unknown>
}> = []
const queries: Array<{
  operation: string
  sql: string
  values: ReadonlyArray<unknown>
}> = []
const rows: Array<{ recipe: unknown }> = []
const newerBrick = {
  ...builtinTailscaleBrick,
  metadata: {
    ...builtinTailscaleBrick.metadata,
    id: "custom-networking",
    name: "Custom Networking",
  },
  source: "https://example.com/custom-networking.yml",
}

const databaseLayer = Layer.succeed(Database)({
  execute: (operation, sql, values) =>
    Effect.sync(() => {
      statements.push({ operation, sql, values: values ?? [] })
      return emptyResult
    }),
  queryRows: <TRow extends RowDataPacket>(
    operation: string,
    sql: string,
    values?: Array<boolean | Buffer | Date | null | number | string>
  ) =>
    Effect.sync(() => {
      queries.push({ operation, sql, values: values ?? [] })
      return rows as unknown as ReadonlyArray<TRow>
    }),
  transaction: () => Effect.die("Unexpected database transaction"),
})

describe("custom Brick persistence", () => {
  layer(databaseLayer)((it) => {
    it.effect("upserts a recipe for its owner and source", () =>
      Effect.gen(function* () {
        statements.length = 0

        const saved = yield* saveCustomBrickEffect(
          "user-one",
          builtinTailscaleBrick
        )

        assert.deepEqual(saved, builtinTailscaleBrick)
        assert.strictEqual(statements.length, 1)
        assert.strictEqual(statements[0]?.operation, "customBricks.save")
        assert.include(statements[0]?.sql, "ON DUPLICATE KEY UPDATE")
        assert.strictEqual(statements[0]?.values[1], "user-one")
        assert.match(String(statements[0]?.values[2]), /^[a-f0-9]{64}$/u)
        assert.strictEqual(
          statements[0]?.values[3],
          builtinTailscaleBrick.source
        )
        assert.deepEqual(
          JSON.parse(String(statements[0]?.values[4])),
          builtinTailscaleBrick
        )
      })
    )

    it.effect("keeps database recency order and skips invalid recipes", () =>
      Effect.gen(function* () {
        queries.length = 0
        rows.splice(
          0,
          rows.length,
          { recipe: newerBrick },
          { recipe: "not-json" },
          { recipe: JSON.stringify(builtinTailscaleBrick) },
          { recipe: { metadata: { name: "Incomplete" } } }
        )

        const bricks = yield* listCustomBricksEffect("user-one")

        assert.deepEqual(bricks, [newerBrick, builtinTailscaleBrick])
        assert.strictEqual(queries[0]?.operation, "customBricks.list")
        assert.include(queries[0]?.sql, "ORDER BY updated_at DESC")
        assert.deepEqual(queries[0]?.values, ["user-one"])
      })
    )
  })
})
