import { z } from "zod"

import { commandError } from "./errors.js"

export interface CliArguments {
  atomic: boolean
  brick?: string
  command: Array<string>
  confirm?: string
  disk?: string
  deleteManaged: boolean
  excludes: Array<string>
  follow: boolean
  gameVersion?: string
  help: boolean
  javaVersion?: string
  json: boolean
  limit: number
  memory?: string
  manifest?: string
  maxDelete: number
  maxDeleteProvided: boolean
  mode?: "full" | "incremental"
  name?: string
  noOpen: boolean
  plan: boolean
  profile?: string
  safetyBackup: boolean
  storage?: string
  stagingPath?: string
  token?: string
  url?: string
  variables: Array<string>
  version: boolean
  start: boolean
}

export function parseArguments(argv: Array<string>): CliArguments {
  let atomic = false
  const command: Array<string> = []
  let brick: string | undefined
  let confirm: string | undefined
  let disk: string | undefined
  let deleteManaged = false
  const excludes: Array<string> = []
  let follow = false
  let gameVersion: string | undefined
  let help = false
  let limit = 2_000
  let javaVersion: string | undefined
  let json = false
  let memory: string | undefined
  let manifest: string | undefined
  let maxDelete = 0
  let maxDeleteProvided = false
  let mode: "full" | "incremental" | undefined
  let name: string | undefined
  let noOpen = false
  let plan = false
  let profile: string | undefined
  let safetyBackup = true
  let storage: string | undefined
  let stagingPath: string | undefined
  let token: string | undefined
  let url: string | undefined
  const variables: Array<string> = []
  let version = false
  let start = true

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument) continue
    const [flag, inlineValue] = argument.split("=", 2)
    const value = () => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[index + 1]
      if (!next || next.startsWith("--")) {
        throw commandError({
          code: "invalid_arguments",
          exitCode: 2,
          message: `${flag} requires a value.`,
        })
      }
      index += 1
      return next
    }
    if (flag === "--atomic") atomic = true
    else if (flag === "--brick") brick = value()
    else if (flag === "--confirm") confirm = value()
    else if (flag === "--disk") disk = value()
    else if (flag === "--delete-managed") deleteManaged = true
    else if (flag === "--exclude") excludes.push(value())
    else if (flag === "--follow" || flag === "-f") follow = true
    else if (flag === "--game-version") gameVersion = value()
    else if (flag === "--help" || flag === "-h") help = true
    else if (flag === "--java-version") javaVersion = value()
    else if (flag === "--json") json = true
    else if (flag === "--memory") memory = value()
    else if (flag === "--manifest") manifest = value()
    else if (flag === "--max-delete") {
      maxDeleteProvided = true
      const parsed = z.coerce
        .number()
        .int()
        .min(0)
        .max(100_000)
        .safeParse(value())
      if (!parsed.success) {
        throw commandError({
          code: "invalid_arguments",
          exitCode: 2,
          message: "--max-delete must be an integer from 0 to 100000.",
        })
      }
      maxDelete = parsed.data
    } else if (flag === "--mode") {
      const parsed = z.enum(["full", "incremental"]).safeParse(value())
      if (!parsed.success) {
        throw commandError({
          code: "invalid_arguments",
          exitCode: 2,
          message: "--mode must be full or incremental.",
        })
      }
      mode = parsed.data
    } else if (flag === "--no-open") noOpen = true
    else if (flag === "--plan") plan = true
    else if (flag === "--no-safety-backup") safetyBackup = false
    else if (flag === "--no-start") start = false
    else if (flag === "--version" || flag === "-v") version = true
    else if (flag === "--limit") {
      const parsed = z.coerce
        .number()
        .int()
        .min(1)
        .max(10_000)
        .safeParse(value())
      if (!parsed.success) {
        throw commandError({
          code: "invalid_arguments",
          exitCode: 2,
          message: "--limit must be an integer from 1 to 10000.",
        })
      }
      limit = parsed.data
    } else if (flag === "--name") name = value()
    else if (flag === "--profile") profile = value()
    else if (flag === "--storage") storage = value()
    else if (flag === "--staging-path") stagingPath = value()
    else if (flag === "--token") token = value()
    else if (flag === "--url") url = value()
    else if (flag === "--variable") variables.push(value())
    else if (argument.startsWith("-")) {
      throw commandError({
        code: "invalid_arguments",
        exitCode: 2,
        message: `Unknown option: ${argument}`,
      })
    } else command.push(argument)
  }
  if (
    (atomic ||
      deleteManaged ||
      excludes.length > 0 ||
      json ||
      manifest !== undefined ||
      maxDeleteProvided ||
      plan ||
      stagingPath !== undefined) &&
    !(command[0] === "files" && command[1] === "sync")
  ) {
    throw commandError({
      code: "invalid_arguments",
      exitCode: 2,
      message:
        "Deployment sync options are only supported by `kiln files sync`.",
    })
  }
  return {
    atomic,
    ...(brick ? { brick } : {}),
    command,
    ...(confirm ? { confirm } : {}),
    ...(disk ? { disk } : {}),
    deleteManaged,
    excludes,
    follow,
    ...(gameVersion ? { gameVersion } : {}),
    help,
    ...(javaVersion ? { javaVersion } : {}),
    json,
    limit,
    ...(memory ? { memory } : {}),
    ...(manifest ? { manifest } : {}),
    maxDelete,
    maxDeleteProvided,
    ...(mode ? { mode } : {}),
    ...(name ? { name } : {}),
    noOpen,
    plan,
    ...(profile ? { profile } : {}),
    safetyBackup,
    ...(storage ? { storage } : {}),
    ...(stagingPath ? { stagingPath } : {}),
    ...(token ? { token } : {}),
    ...(url ? { url } : {}),
    variables,
    version,
    start,
  }
}
