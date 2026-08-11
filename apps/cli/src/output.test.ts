import { Cause } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { z } from "zod"

import { commandError } from "./errors.js"
import { formatBytes, renderErrorCause, renderTable } from "./output.js"

describe("CLI output", () => {
  it("renders aligned text tables", () => {
    expect(
      renderTable(
        ["NAME", "STATE", "ID"],
        [
          ["Survival", "running", "relay:one"],
          ["Creative", "offline", "relay:two"],
        ]
      )
    ).toBe(
      [
        "NAME      STATE    ID",
        "Survival  running  relay:one",
        "Creative  offline  relay:two",
      ].join("\n")
    )
  })

  it("formats file sizes for people", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1_536)).toBe("1.5 KiB")
    expect(formatBytes(10 * 1_024 * 1_024)).toBe("10 MiB")
  })

  it("preserves typed errors that become defects", () => {
    expect(
      renderErrorCause(
        Cause.die(
          commandError({
            code: "invalid_url",
            exitCode: 2,
            message: "Kiln URL must be an absolute HTTP or HTTPS URL.",
          })
        )
      )
    ).toEqual({
      exitCode: 2,
      output: [
        "Error: Kiln URL must be an absolute HTTP or HTTPS URL.",
        "Code: invalid_url",
        "",
      ].join("\n"),
    })
  })

  it("includes concise details for typed failures", () => {
    expect(
      renderErrorCause(
        Cause.fail(
          commandError({
            cause: new Error("connect ECONNREFUSED kiln.example.test:443"),
            code: "network_error",
            exitCode: 5,
            message: "Could not reach https://kiln.example.test.",
            retryable: true,
          })
        )
      )
    ).toEqual({
      exitCode: 5,
      output: [
        "Error: Could not reach https://kiln.example.test.",
        "Code: network_error",
        "Cause: connect ECONNREFUSED kiln.example.test:443",
        "Hint: This operation may succeed if retried.",
        "",
      ].join("\n"),
    })
  })

  it("identifies invalid response fields without dumping the response", () => {
    const decoded = z
      .object({ instance: z.object({ state: z.string() }) })
      .safeParse({ instance: {} })
    expect(decoded.success).toBe(false)
    if (decoded.success) return

    const report = renderErrorCause(
      Cause.fail(
        commandError({
          cause: decoded.error,
          code: "invalid_response",
          message: "Hearth returned a response the CLI does not understand.",
        })
      )
    )

    expect(report.output).toContain(
      "Cause: instance.state: Invalid input: expected string, received undefined"
    )
    expect(report.output).not.toContain('{"instance":{}}')
  })

  it("reports the message from unexpected defects", () => {
    expect(
      renderErrorCause(Cause.die(new TypeError("Cannot decode power response")))
    ).toEqual({
      exitCode: 1,
      output: [
        "Error: Cannot decode power response",
        "Code: unexpected_error",
        "",
      ].join("\n"),
    })
  })
})
