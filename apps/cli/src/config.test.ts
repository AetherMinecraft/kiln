import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"

import {
  loadConfigEffect,
  removeSessionEffect,
  resolveSessionEffect,
  saveSessionEffect,
  type ConfigOptions,
} from "./config.js"
import type { CredentialManager } from "./credential-store.js"

describe("CLI credential persistence", () => {
  it("stores profile secrets outside the config file", async () => {
    const fixture = await configFixture()
    try {
      const manager = memoryCredentialManager()
      const saved = await Effect.runPromise(
        saveSessionEffect(
          {
            profile: "workstation",
            token: "kiln_cli_external_secret",
            url: "https://kiln.example.test",
          },
          fixture.options([manager])
        )
      )

      assert.isTrue(saved.protected)
      assert.strictEqual(saved.credentialManager, manager.id)
      const encoded = await readFile(fixture.path, "utf8")
      assert.notInclude(encoded, "kiln_cli_external_secret")
      assert.include(encoded, '"kind": "external"')
      assert.include(encoded, `"manager": "${manager.id}"`)

      const session = await Effect.runPromise(
        resolveSessionEffect({}, fixture.options([manager]))
      )
      assert.strictEqual(session.token, "kiln_cli_external_secret")
      assert.strictEqual(session.profile, "workstation")
    } finally {
      await fixture.cleanup()
    }
  })

  it("migrates version 1 plaintext profiles into the credential manager", async () => {
    const fixture = await configFixture()
    try {
      await writeFile(
        fixture.path,
        `${JSON.stringify({
          activeProfile: "legacy",
          profiles: {
            legacy: {
              token: "kiln_cli_legacy_secret",
              url: "https://kiln.example.test",
            },
          },
          version: 1,
        })}\n`,
        { mode: 0o600 }
      )
      const manager = memoryCredentialManager()

      const config = await Effect.runPromise(
        loadConfigEffect(fixture.options([manager]))
      )

      assert.strictEqual(config.version, 2)
      const encoded = await readFile(fixture.path, "utf8")
      assert.notInclude(encoded, "kiln_cli_legacy_secret")
      assert.include(encoded, '"kind": "external"')
      assert.deepStrictEqual(
        [...manager.passwords.values()],
        ["kiln_cli_legacy_secret"]
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps version 1 intact when native credential migration fails", async () => {
    const fixture = await configFixture()
    try {
      const legacy = {
        activeProfile: "legacy",
        profiles: {
          legacy: {
            token: "kiln_cli_retry_secret",
            url: "https://kiln.example.test",
          },
        },
        version: 1,
      } as const
      await writeFile(fixture.path, `${JSON.stringify(legacy)}\n`, {
        mode: 0o600,
      })
      const unavailable = failingCredentialManager()

      await expect(
        Effect.runPromise(loadConfigEffect(fixture.options([unavailable])))
      ).rejects.toMatchObject({
        code: "credential_store_failed",
        retryable: true,
      })

      assert.deepStrictEqual(
        JSON.parse(await readFile(fixture.path, "utf8")),
        legacy
      )

      const recovered = memoryCredentialManager()
      const config = await Effect.runPromise(
        loadConfigEffect(fixture.options([recovered]))
      )
      assert.strictEqual(config.version, 2)
      assert.notInclude(await readFile(fixture.path, "utf8"), "retry_secret")
      assert.deepStrictEqual(
        [...recovered.passwords.values()],
        ["kiln_cli_retry_secret"]
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("migrates to the file fallback when no native manager exists", async () => {
    const fixture = await configFixture()
    try {
      await writeFile(
        fixture.path,
        `${JSON.stringify({
          activeProfile: "headless",
          profiles: {
            headless: {
              token: "kiln_cli_headless_secret",
              url: "https://kiln.example.test",
            },
          },
          version: 1,
        })}\n`,
        { mode: 0o600 }
      )

      const config = await Effect.runPromise(
        loadConfigEffect(fixture.options([]))
      )

      assert.strictEqual(config.version, 2)
      assert.deepStrictEqual(config.profiles.headless?.credential, {
        kind: "file",
        token: "kiln_cli_headless_secret",
      })
      assert.strictEqual((await stat(fixture.path)).mode & 0o777, 0o600)
    } finally {
      await fixture.cleanup()
    }
  })

  it("does not write a file fallback when credential storage is interrupted", async () => {
    const fixture = await configFixture()
    let startedResolve: () => void = () => undefined
    const started = new Promise<void>((resolvePromise) => {
      startedResolve = resolvePromise
    })
    let storeSignal: AbortSignal | undefined
    const interrupted: CredentialManager = {
      id: "interrupted",
      label: "Interrupted manager",
      deletePassword: async () => false,
      getPassword: async () => null,
      setPassword: async (_account, _password, signal) => {
        storeSignal = signal
        startedResolve()
        await new Promise<never>((_resolvePromise, rejectPromise) => {
          if (signal?.aborted) {
            rejectPromise(signal.reason)
            return
          }
          signal?.addEventListener(
            "abort",
            () => rejectPromise(signal.reason),
            { once: true }
          )
        })
      },
    }
    try {
      const fiber = Effect.runFork(
        saveSessionEffect(
          {
            profile: "interrupted",
            token: "kiln_cli_interrupted_secret",
            url: "https://kiln.example.test",
          },
          fixture.options([interrupted])
        )
      )
      await started
      await Effect.runPromise(Fiber.interrupt(fiber))

      assert.isTrue(storeSignal?.aborted ?? false)
      await expect(readFile(fixture.path, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it("uses an owner-only file fallback during explicit session save", async () => {
    const fixture = await configFixture()
    try {
      const unavailable: CredentialManager = {
        id: "unavailable",
        label: "Unavailable manager",
        deletePassword: async () => false,
        getPassword: async () => null,
        setPassword: async () => {
          throw new Error("unavailable")
        },
      }
      const saved = await Effect.runPromise(
        saveSessionEffect(
          {
            profile: "fallback",
            token: "kiln_cli_file_secret",
            url: "https://kiln.example.test",
          },
          fixture.options([unavailable])
        )
      )

      assert.isFalse(saved.protected)
      const encoded = await readFile(fixture.path, "utf8")
      assert.include(encoded, "kiln_cli_file_secret")
      assert.include(encoded, '"kind": "file"')
      assert.strictEqual((await stat(fixture.path)).mode & 0o777, 0o600)
    } finally {
      await fixture.cleanup()
    }
  })

  it("removes both profile metadata and its external credential", async () => {
    const fixture = await configFixture()
    try {
      const manager = memoryCredentialManager()
      await Effect.runPromise(
        saveSessionEffect(
          {
            profile: "delete-me",
            token: "kiln_cli_delete_secret",
            url: "https://kiln.example.test",
          },
          fixture.options([manager])
        )
      )
      assert.strictEqual(manager.passwords.size, 1)

      const removed = await Effect.runPromise(
        removeSessionEffect("delete-me", fixture.options([manager]))
      )

      assert.isTrue(removed.removed)
      assert.isTrue(removed.credentialRemoved)
      assert.strictEqual(manager.passwords.size, 0)
      assert.notInclude(await readFile(fixture.path, "utf8"), "delete-me")
    } finally {
      await fixture.cleanup()
    }
  })
})

function memoryCredentialManager(): CredentialManager & {
  passwords: Map<string, string>
} {
  const passwords = new Map<string, string>()
  return {
    id: "memory-v1",
    label: "Memory credential manager",
    passwords,
    deletePassword: async (account) => passwords.delete(account),
    getPassword: async (account) => passwords.get(account) ?? null,
    setPassword: async (account, password) => {
      passwords.set(account, password)
    },
  }
}

function failingCredentialManager(): CredentialManager {
  return {
    id: "unavailable",
    label: "Unavailable manager",
    deletePassword: async () => false,
    getPassword: async () => null,
    setPassword: async () => {
      throw new Error("unavailable")
    },
  }
}

async function configFixture() {
  const directory = await mkdtemp(join(tmpdir(), "kiln-cli-config-test-"))
  const path = join(directory, "config.json")
  return {
    cleanup: () => rm(directory, { force: true, recursive: true }),
    options: (
      credentialManagers: ReadonlyArray<CredentialManager>
    ): ConfigOptions => ({
      credentialManagers,
      environment: { KILN_CONFIG: path },
    }),
    path,
  }
}
