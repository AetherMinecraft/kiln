import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { Effect, Exit } from "effect"
import { z } from "zod"

import {
  credentialManagersForPlatform,
  type CredentialManager,
} from "./credential-store.js"
import { commandError } from "./errors.js"

export const DEFAULT_KILN_URL = "https://kiln.site"

const tokenSchema = z.string().startsWith("kiln_cli_")

const externalCredentialSchema = z.object({
  account: z.string().min(1),
  kind: z.literal("external"),
  manager: z.string().min(1),
})

const fileCredentialSchema = z.object({
  kind: z.literal("file"),
  token: tokenSchema,
})

const profileSchema = z.object({
  credential: z.union([externalCredentialSchema, fileCredentialSchema]),
  url: z.url(),
})

const configSchema = z.object({
  activeProfile: z.string().min(1).default("default"),
  profiles: z.record(z.string(), profileSchema).default({}),
  version: z.literal(2),
})

const legacyProfileSchema = z.object({
  token: tokenSchema,
  url: z.url(),
})

const legacyConfigSchema = z.object({
  activeProfile: z.string().min(1).default("default"),
  profiles: z.record(z.string(), legacyProfileSchema).default({}),
  version: z.literal(1),
})

type KilnConfig = z.infer<typeof configSchema>
type KilnCredential = z.infer<typeof profileSchema>["credential"]
type LegacyKilnConfig = z.infer<typeof legacyConfigSchema>

export interface KilnSession {
  profile: string
  token: string
  url: string
}

export interface ConfigOptions {
  credentialManagers?: ReadonlyArray<CredentialManager>
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
}

export interface SavedSession {
  credentialManager: string
  credentialManagerLabel: string
  protected: boolean
}

const emptyConfig: KilnConfig = {
  activeProfile: "default",
  profiles: {},
  version: 2,
}

export const loadConfigEffect = Effect.fn("cli.config.load")(function* (
  options: ConfigOptions = {}
) {
  const path = configPath(options)
  const encoded = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      if (isFileNotFound(cause)) return Effect.succeed(null)
      return Effect.fail(
        commandError({
          cause,
          code: "config_read_failed",
          message: `Could not read Kiln config at ${path}.`,
        })
      )
    })
  )
  if (encoded === null) return emptyConfig
  const parsed = yield* Effect.try({
    try: () => JSON.parse(encoded) as unknown,
    catch: (cause) =>
      commandError({
        cause,
        code: "invalid_config",
        exitCode: 2,
        message: `Kiln config at ${path} is invalid.`,
      }),
  })
  const current = configSchema.safeParse(parsed)
  if (current.success) return current.data
  const legacy = legacyConfigSchema.safeParse(parsed)
  if (!legacy.success) {
    return yield* commandError({
      cause: current.error,
      code: "invalid_config",
      exitCode: 2,
      message: `Kiln config at ${path} is invalid.`,
    })
  }
  return yield* migrateLegacyConfigEffect(legacy.data, options)
})

export const resolveSessionEffect = Effect.fn("cli.config.resolveSession")(
  function* (
    input: { profile?: string; token?: string; url?: string },
    options: ConfigOptions = {}
  ) {
    const config = yield* loadConfigEffect(options)
    const profile = input.profile || config.activeProfile || "default"
    const stored = config.profiles[profile]
    const environment = options.environment ?? process.env
    const token =
      input.token ||
      environment.KILN_TOKEN?.trim() ||
      (stored ? yield* loadCredentialEffect(stored.credential, options) : null)
    const url = normalizeKilnUrl(
      input.url ||
        environment.KILN_URL?.trim() ||
        stored?.url ||
        DEFAULT_KILN_URL
    )
    if (!token) {
      return yield* commandError({
        code: "authentication_required",
        exitCode: 3,
        message: "Run `kiln login` or provide KILN_TOKEN.",
      })
    }
    return { profile, token, url } satisfies KilnSession
  }
)

export const saveSessionEffect = Effect.fn("cli.config.saveSession")(function* (
  session: KilnSession,
  options: ConfigOptions = {}
) {
  const config = yield* loadConfigEffect(options)
  const existing = config.profiles[session.profile]?.credential
  const account =
    existing && existing.kind === "external"
      ? existing.account
      : credentialAccount(configPath(options), session.profile)
  const saved = yield* saveCredentialEffect(account, session.token, options)
  const next: KilnConfig = {
    activeProfile: session.profile,
    profiles: {
      ...config.profiles,
      [session.profile]: { credential: saved.credential, url: session.url },
    },
    version: 2,
  }
  yield* writeConfigEffect(next, options)
  if (
    existing &&
    existing.kind === "external" &&
    (saved.credential.kind === "file" ||
      existing.manager !== saved.credential.manager)
  ) {
    yield* deleteExternalCredentialEffect(existing, options).pipe(Effect.ignore)
  }
  return saved.summary
})

export const removeSessionEffect = Effect.fn("cli.config.removeSession")(
  function* (profileName?: string, options: ConfigOptions = {}) {
    const config = yield* loadConfigEffect(options)
    const profile = profileName || config.activeProfile || "default"
    const removed = config.profiles[profile]
    const profiles = Object.fromEntries(
      Object.entries(config.profiles).filter(([name]) => name !== profile)
    )
    yield* writeConfigEffect(
      {
        activeProfile:
          config.activeProfile === profile ? "default" : config.activeProfile,
        profiles,
        version: 2,
      },
      options
    )
    const credentialRemoved =
      removed && removed.credential.kind === "external"
        ? yield* deleteExternalCredentialEffect(
            removed.credential,
            options
          ).pipe(Effect.catch(() => Effect.succeed(false)))
        : true
    return {
      credentialRemoved,
      profile,
      removed: Boolean(removed),
    }
  }
)

export function normalizeKilnUrl(input: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(input)
    ? input
    : `https://${input}`
  const parsed = z.url().safeParse(candidate)
  if (!parsed.success) {
    throw commandError({
      code: "invalid_url",
      exitCode: 2,
      message: "Kiln URL must be an absolute HTTP or HTTPS URL.",
    })
  }
  const url = new URL(parsed.data)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw commandError({
      code: "invalid_url",
      exitCode: 2,
      message: "Kiln URL must use HTTP or HTTPS.",
    })
  }
  return url.toString().replace(/\/$/u, "")
}

function migrateLegacyConfigEffect(
  legacy: LegacyKilnConfig,
  options: ConfigOptions
) {
  return Effect.gen(function* () {
    const path = configPath(options)
    const profiles: KilnConfig["profiles"] = {}
    for (const [profile, value] of Object.entries(legacy.profiles)) {
      const saved = yield* saveCredentialEffect(
        credentialAccount(path, profile),
        value.token,
        options
      )
      profiles[profile] = { credential: saved.credential, url: value.url }
    }
    const migrated: KilnConfig = {
      activeProfile: legacy.activeProfile,
      profiles,
      version: 2,
    }
    yield* writeConfigEffect(migrated, options)
    return migrated
  })
}

function loadCredentialEffect(
  credential: KilnCredential,
  options: ConfigOptions
) {
  if (credential.kind === "file") return Effect.succeed(credential.token)
  const manager = credentialManagers(options).find(
    (candidate) => candidate.id === credential.manager
  )
  if (!manager) {
    return Effect.fail(
      commandError({
        code: "credential_manager_unavailable",
        exitCode: 3,
        message: `The saved credential requires ${credential.manager}, which is unavailable on this system.`,
      })
    )
  }
  return Effect.tryPromise({
    try: (signal) => manager.getPassword(credential.account, signal),
    catch: (cause) =>
      commandError({
        cause,
        code: "credential_read_failed",
        exitCode: 3,
        message: `Could not read the Kiln credential from ${manager.label}.`,
      }),
  }).pipe(
    Effect.flatMap((token) =>
      token
        ? Effect.succeed(token)
        : Effect.fail(
            commandError({
              code: "authentication_required",
              exitCode: 3,
              message: `The Kiln credential is missing from ${manager.label}. Run \`kiln login\` again.`,
            })
          )
    )
  )
}

function saveCredentialEffect(
  account: string,
  token: string,
  options: ConfigOptions
) {
  return Effect.gen(function* () {
    for (const manager of credentialManagers(options)) {
      const stored = yield* Effect.exit(
        Effect.tryPromise((signal) =>
          manager.setPassword(account, token, signal)
        )
      )
      if (Exit.isSuccess(stored)) {
        return {
          credential: {
            account,
            kind: "external",
            manager: manager.id,
          } satisfies KilnCredential,
          summary: {
            credentialManager: manager.id,
            credentialManagerLabel: manager.label,
            protected: true,
          } satisfies SavedSession,
        }
      }
    }
    return {
      credential: { kind: "file", token } satisfies KilnCredential,
      summary: {
        credentialManager: "file",
        credentialManagerLabel: "the Kiln config file",
        protected: false,
      } satisfies SavedSession,
    }
  })
}

function deleteExternalCredentialEffect(
  credential: z.infer<typeof externalCredentialSchema>,
  options: ConfigOptions
) {
  const manager = credentialManagers(options).find(
    (candidate) => candidate.id === credential.manager
  )
  if (!manager) return Effect.succeed(false)
  return Effect.tryPromise((signal) =>
    manager.deletePassword(credential.account, signal)
  )
}

function credentialManagers(
  options: ConfigOptions
): ReadonlyArray<CredentialManager> {
  return options.credentialManagers ?? credentialManagersForPlatform()
}

function credentialAccount(path: string, profile: string): string {
  const digest = createHash("sha256")
    .update(resolve(path))
    .update("\0")
    .update(profile)
    .digest("hex")
  return `profile-${digest}`
}

function configPath(options: ConfigOptions): string {
  const environment = options.environment ?? process.env
  const configured = environment.KILN_CONFIG?.trim()
  if (configured) return configured
  const base =
    environment.XDG_CONFIG_HOME?.trim() ||
    join(options.homeDirectory ?? homedir(), ".config")
  return join(base, "kiln", "config.json")
}

function writeConfigEffect(config: KilnConfig, options: ConfigOptions) {
  const path = configPath(options)
  const temporary = `${path}.tmp-${process.pid}`
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
      })
      await chmod(temporary, 0o600)
      await rename(temporary, path)
    },
    catch: (cause) =>
      commandError({
        cause,
        code: "config_write_failed",
        message: `Could not write Kiln config at ${path}.`,
      }),
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => unlink(temporary),
        catch: () => undefined,
      }).pipe(Effect.ignore)
    )
  )
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  )
}
