import { describe, expect, it } from "vite-plus/test"
import { formatRelayInstanceStateReason } from "@workspace/contracts"

describe("server state reasons", () => {
  it("keeps readiness feedback concise", () => {
    expect(
      formatRelayInstanceStateReason({ code: "waiting_for_readiness" })
    ).toBe("Waiting for the configured server port to accept connections.")
  })

  it("includes process evidence for automatic recovery", () => {
    expect(
      formatRelayInstanceStateReason({
        code: "automatic_recovery",
        exitCode: 137,
        phase: "restarting",
        reason: "process_exit",
      })
    ).toBe(
      "Automatic recovery is restarting the server after process exit code 137."
    )
  })

  it("explains an OOM kill during a requested stop", () => {
    expect(
      formatRelayInstanceStateReason({
        code: "out_of_memory_while_stopping",
      })
    ).toBe(
      "Stopping triggered an out-of-memory kill. The server is stopped, but shutdown was not graceful; increase memory or use its console stop command."
    )
  })
})
