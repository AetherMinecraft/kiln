import { assert, describe, it } from "@effect/vitest"

import {
  credentialManagersForPlatform,
  macosKeychainCredentialManager,
  windowsCredentialManager,
  type CredentialCommand,
  type CredentialCommandResult,
} from "./credential-store.js"

const success = (stdout = ""): CredentialCommandResult => ({
  exitCode: 0,
  stderr: "",
  stdout,
})

describe("CLI credential managers", () => {
  it("selects only the native manager for supported desktop platforms", () => {
    assert.deepStrictEqual(
      credentialManagersForPlatform("darwin", async () => success()).map(
        (manager) => manager.id
      ),
      ["macos-keychain-v1"]
    )
    assert.deepStrictEqual(
      credentialManagersForPlatform("win32", async () => success()).map(
        (manager) => manager.id
      ),
      ["windows-credential-manager-v1"]
    )
    assert.deepStrictEqual(
      credentialManagersForPlatform("linux", async () => success()),
      []
    )
  })

  it("passes macOS secrets through stdin instead of process arguments", async () => {
    const commands: Array<CredentialCommand> = []
    const manager = macosKeychainCredentialManager(async (command) => {
      commands.push(command)
      return success()
    })

    await manager.setPassword("profile-account", "kiln_cli_secret")

    assert.strictEqual(commands.length, 1)
    assert.strictEqual(commands[0]?.executable, "/usr/bin/security")
    assert.notInclude(commands[0]?.arguments, "kiln_cli_secret")
    assert.deepStrictEqual(commands[0]?.promptResponses, [
      {
        prompt: "password data for new item:",
        response: "kiln_cli_secret\n",
      },
      {
        prompt: "retype password for new item:",
        response: "kiln_cli_secret\n",
      },
    ])
    assert.strictEqual(commands[0]?.arguments.at(-1), "-w")
  })

  it("reads and deletes macOS Keychain credentials", async () => {
    const commands: Array<CredentialCommand> = []
    const results = [success("kiln_cli_secret\n"), success()]
    const manager = macosKeychainCredentialManager(async (command) => {
      commands.push(command)
      return results.shift() ?? success()
    })

    assert.strictEqual(
      await manager.getPassword("profile-account"),
      "kiln_cli_secret"
    )
    assert.isTrue(await manager.deletePassword("profile-account"))
    assert.strictEqual(commands[0]?.arguments[0], "find-generic-password")
    assert.strictEqual(commands[1]?.arguments[0], "delete-generic-password")
  })

  it("treats missing native credentials as absent", async () => {
    const missing = async (): Promise<CredentialCommandResult> => ({
      exitCode: 44,
      stderr: "not found",
      stdout: "",
    })

    assert.isNull(
      await macosKeychainCredentialManager(missing).getPassword("missing")
    )
    assert.isFalse(
      await windowsCredentialManager(missing).deletePassword("missing")
    )
  })

  it("passes Windows secrets through stdin instead of process arguments", async () => {
    const commands: Array<CredentialCommand> = []
    const manager = windowsCredentialManager(async (command) => {
      commands.push(command)
      return success()
    })

    await manager.setPassword("profile-account", "kiln_cli_secret")

    assert.strictEqual(commands.length, 1)
    assert.match(
      commands[0]?.executable ?? "",
      /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/u
    )
    assert.notInclude(commands[0]?.arguments, "kiln_cli_secret")
    assert.notInclude(commands[0]?.arguments, "site.kiln.cli:profile-account")
    assert.deepStrictEqual(JSON.parse(commands[0]?.input ?? ""), {
      account: "profile-account",
      password: "kiln_cli_secret",
      target: "site.kiln.cli:profile-account",
    })
  })
})
