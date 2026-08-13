import { spawn } from "node:child_process"

import { Effect } from "effect"

import { commandError } from "./errors.js"

export interface CliUpdateCommand {
  arguments: ReadonlyArray<string>
  executable: string
}

export type CliUpdateRunner = (
  command: CliUpdateCommand,
  signal: AbortSignal
) => Promise<void>

export const updateCliEffect = Effect.fn("cli.update")(function* (
  runUpdate: CliUpdateRunner = runNpmUpdate
) {
  const command = npmUpdateCommand()
  yield* Effect.tryPromise({
    try: (signal) => runUpdate(command, signal),
    catch: (cause) =>
      commandError({
        cause,
        code: "cli_update_failed",
        message: "npm could not update the Kiln CLI.",
      }),
  })
})

export function npmUpdateCommand(
  platform: NodeJS.Platform = process.platform
): CliUpdateCommand {
  return {
    arguments: ["install", "--global", "kiln-cli@latest"],
    executable: platform === "win32" ? "npm.cmd" : "npm",
  }
}

function runNpmUpdate(
  command: CliUpdateCommand,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, command.arguments, {
      signal,
      stdio: "inherit",
    })
    child.once("error", rejectPromise)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(
        new Error(
          signal
            ? `npm was terminated by ${signal}.`
            : `npm exited with code ${code ?? "unknown"}.`
        )
      )
    })
  })
}
