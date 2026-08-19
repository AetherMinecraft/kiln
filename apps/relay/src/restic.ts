import { createHash } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { lstat, mkdir, opendir, rename, rm } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"

import { Effect, Result } from "effect"

import { RelayBackupError } from "./effect/errors.js"
import type { RelayConfig } from "./config.js"

const RESTIC_BINARY = "restic"
const MAX_JSON_LINE_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MAX_STAGING_ENTRIES = 100_000
const MAX_UNLIMITED_RESTORE_BYTES = 1024 ** 4

export type ResticProgress = {
  bytesCompleted: number
  bytesTotal: number | null
}

export type ResticSnapshotSummary = {
  snapshotId: string
  totalBytesProcessed: number
}

export type TranslatedExcludes = {
  excludes: Array<string>
  warnings: Array<string>
}

export type ResticSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    stdio: ["ignore", "pipe", "pipe"]
  }
) => ChildProcess

export type ResticDriver = {
  backup: (input: {
    cwd: string
    excludes: ReadonlyArray<string>
    onProgress?: (progress: ResticProgress) => void
    password: string
    path: string
    repository: string
    signal: AbortSignal
    tags: ReadonlyArray<string>
  }) => Promise<ResticSnapshotSummary>
  catConfig: (input: {
    password: string
    repository: string
    signal: AbortSignal
  }) => Promise<boolean>
  dumpZip: (input: {
    destination: string
    onProgress?: (bytes: number) => void
    password: string
    repository: string
    selector: string
    signal: AbortSignal
  }) => Promise<{ bytes: number; checksumSha256: string }>
  forget: (input: {
    password: string
    repository: string
    signal: AbortSignal
    snapshotId: string
  }) => Promise<void>
  init: (input: {
    password: string
    repository: string
    signal: AbortSignal
  }) => Promise<void>
  prune: (input: {
    onProgress?: (progress: ResticProgress) => void
    password: string
    repository: string
    signal: AbortSignal
  }) => Promise<void>
  restore: (input: {
    onProgress?: (progress: ResticProgress) => void
    password: string
    repository: string
    selector: string
    signal: AbortSignal
    target: string
  }) => Promise<void>
  snapshotsByTag: (input: {
    password: string
    repository: string
    signal: AbortSignal
    tag: string
  }) => Promise<Array<{ id: string }>>
  stats: (input: {
    password: string
    repository: string
    signal: AbortSignal
    snapshotId: string
  }) => Promise<{ totalSize: number }>
}

export function resticRepositoryPath(
  config: RelayConfig,
  targetId: string
): string {
  return resolve(config.dataDirectory, "restic", "instance", targetId)
}

export function resticSnapshotSelector(
  snapshotId: string,
  instanceDirectory: string
): string {
  return `${snapshotId}:${instanceDirectory}`
}

export function requiredRepositoryPassword(
  password: string | undefined,
  operation: string
): string {
  if (!password) {
    throw RelayBackupError.make({
      code: "repository_password_missing",
      operation,
      reason: "The restic repository password was not provided to Relay",
    })
  }
  return password
}

export function translateExcludePatterns(
  patterns: ReadonlyArray<string>
): TranslatedExcludes {
  const excludes: Array<string> = []
  const warnings: Array<string> = []
  const seen = new Set<string>()
  const add = (pattern: string) => {
    if (seen.has(pattern)) return
    seen.add(pattern)
    excludes.push(pattern)
  }
  for (const rawPattern of patterns) {
    const trimmed = rawPattern.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (trimmed.startsWith("!")) {
      warnings.push(
        `Skipped unsupported restic exclude negation: ${trimmed}`
      )
      continue
    }
    if (isUnsupportedExcludePattern(trimmed)) {
      warnings.push(`Skipped unsupported restic exclude pattern: ${trimmed}`)
      continue
    }
    add(trimmed)
    if (!trimmed.includes("/")) add(`**/${trimmed}`)
  }
  return { excludes, warnings }
}

export function isUnsupportedExcludePattern(pattern: string): boolean {
  if (pattern.includes("[") || pattern.includes("{")) return true
  return /\?\(|\*\(|\+\(|@\(|!\(/u.test(pattern)
}

export function parseResticJsonLine(line: string): unknown {
  const trimmed = line.trim()
  if (!trimmed) return null
  return Result.getOrElse(
    Result.try(() => JSON.parse(trimmed) as unknown),
    () => null
  )
}

export function progressFromResticStatus(value: unknown): ResticProgress | null {
  if (!isRecord(value) || value.message_type !== "status") return null
  const bytesDone = integerField(value, "bytes_done")
  const totalBytes = integerField(value, "total_bytes")
  if (bytesDone === null && totalBytes === null) return null
  return {
    bytesCompleted: bytesDone ?? 0,
    bytesTotal: totalBytes,
  }
}

export function summaryFromResticJson(value: unknown): ResticSnapshotSummary | null {
  if (!isRecord(value) || value.message_type !== "summary") return null
  const snapshotId = stringField(value, "snapshot_id")
  const totalBytesProcessed = integerField(value, "total_bytes_processed")
  if (!snapshotId || totalBytesProcessed === null) return null
  return { snapshotId, totalBytesProcessed }
}

export function createResticDriver(options?: {
  binary?: string
  spawn?: ResticSpawn
}): ResticDriver {
  const binary = options?.binary ?? RESTIC_BINARY
  const spawnRestic = options?.spawn ?? defaultSpawn
  const run = (
    args: ReadonlyArray<string>,
    input: {
      cwd?: string
      onJson?: (value: unknown) => void
      password: string
      repository: string
      signal: AbortSignal
      stdout?: (chunk: Buffer) => void
    }
  ) =>
    spawnResticCommand(spawnRestic, binary, args, input)

  return {
    backup: async (input) => {
      let summary: ResticSnapshotSummary | null = null
      const result = await run(
        [
          "backup",
          "--json",
          ...input.tags.flatMap((tag) => ["--tag", tag]),
          ...input.excludes.flatMap((pattern) => ["--exclude", pattern]),
          input.path,
        ],
        {
          cwd: input.cwd,
          password: input.password,
          repository: input.repository,
          signal: input.signal,
          onJson: (value) => {
            const progress = progressFromResticStatus(value)
            if (progress) input.onProgress?.(progress)
            const next = summaryFromResticJson(value)
            if (next) summary = next
          },
        }
      )
      if (!summary) {
        throw resticError(
          "restic_backup_summary_missing",
          "create.restic",
          result.stderr || "restic backup did not report a snapshot"
        )
      }
      return summary
    },
    catConfig: async (input) => {
      const result = await resultOf(() =>
        run(["cat", "config"], {
          password: input.password,
          repository: input.repository,
          signal: input.signal,
        })
      )
      if (Result.isFailure(result)) return false
      return result.success.exitCode === 0
    },
    dumpZip: async (input) => {
      await mkdir(dirname(input.destination), { recursive: true, mode: 0o700 })
      await rm(input.destination, { force: true })
      const digest = createHash("sha256")
      let bytes = 0
      const output = createWriteStream(input.destination, {
        flags: "wx",
        mode: 0o600,
      })
      let writeChain = Promise.resolve()
      const dumped = await resultOf(async () => {
        await run(["dump", "-a", "zip", input.selector, "/"], {
          password: input.password,
          repository: input.repository,
          signal: input.signal,
          stdout: (chunk) => {
            bytes += chunk.byteLength
            digest.update(chunk)
            input.onProgress?.(bytes)
            writeChain = writeChain.then(
              () =>
                new Promise<void>((resolveWrite, rejectWrite) => {
                  output.write(chunk, (error) =>
                    error ? rejectWrite(error) : resolveWrite()
                  )
                })
            )
          },
        })
        await writeChain
        await new Promise<void>((resolveClose, rejectClose) => {
          output.end((error: Error | null | undefined) =>
            error ? rejectClose(error) : resolveClose()
          )
        })
        return { bytes, checksumSha256: digest.digest("hex") }
      })
      if (Result.isFailure(dumped)) {
        output.destroy()
        await rm(input.destination, { force: true })
        throw dumped.failure
      }
      return dumped.success
    },
    forget: async (input) => {
      const result = await resultOf(() =>
        run(["forget", input.snapshotId], {
          password: input.password,
          repository: input.repository,
          signal: input.signal,
        })
      )
      if (Result.isSuccess(result)) return
      if (isMissingSnapshotError(result.failure)) return
      throw result.failure
    },
    init: async (input) => {
      await mkdir(input.repository, { recursive: true, mode: 0o700 })
      await run(["init"], {
        password: input.password,
        repository: input.repository,
        signal: input.signal,
      })
    },
    prune: async (input) => {
      await run(["prune", "--json"], {
        password: input.password,
        repository: input.repository,
        signal: input.signal,
        onJson: (value) => {
          const progress = progressFromResticStatus(value)
          if (progress) input.onProgress?.(progress)
        },
      })
    },
    restore: async (input) => {
      await mkdir(input.target, { recursive: true, mode: 0o700 })
      await run(
        ["restore", "--json", input.selector, "--target", input.target],
        {
        password: input.password,
        repository: input.repository,
        signal: input.signal,
        onJson: (value) => {
          const progress = progressFromResticStatus(value)
          if (progress) input.onProgress?.(progress)
        },
      })
    },
    snapshotsByTag: async (input) => {
      const result = await run(
        ["snapshots", "--json", "--tag", input.tag],
        {
          password: input.password,
          repository: input.repository,
          signal: input.signal,
        }
      )
      const parsed = parseResticJsonLine(result.stdoutText)
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((entry) => {
        const id = isRecord(entry) ? stringField(entry, "id") : null
        return id ? [{ id }] : []
      })
    },
    stats: async (input) => {
      const result = await run(
        ["stats", "--mode", "restore-size", "--json", input.snapshotId],
        {
          password: input.password,
          repository: input.repository,
          signal: input.signal,
        }
      )
      const parsed = parseResticJsonLine(result.stdoutText)
      const totalSize = isRecord(parsed) ? integerField(parsed, "total_size") : null
      if (totalSize === null) {
        throw resticError(
          "restic_stats_missing",
          "create.restic",
          "restic stats did not report restore size"
        )
      }
      return { totalSize }
    },
  }
}

export async function validateStagingTree(
  stagingRoot: string,
  limits: { diskBytes: number }
): Promise<{ entries: number; logicalBytes: number }> {
  const root = resolve(stagingRoot)
  const metadata = await lstat(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw resticError(
      "invalid_staging_tree",
      "restore.validate",
      "The restored staging tree is not a directory"
    )
  }
  let entries = 0
  let logicalBytes = 0
  const visit = async (directory: string): Promise<void> => {
    for await (const entry of await opendir(directory)) {
      entries += 1
      if (entries > MAX_STAGING_ENTRIES) {
        throw resticError(
          "too_many_entries",
          "restore.validate",
          `Backups cannot contain more than ${MAX_STAGING_ENTRIES.toLocaleString("en-US")} entries`
        )
      }
      const absolute = resolve(directory, entry.name)
      requireContained(root, absolute, "restore.validate")
      const child = await lstat(absolute)
      if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) {
        throw resticError(
          "unsupported_staging_entry",
          "restore.validate",
          `Restored files cannot include ${relative(root, absolute) || entry.name}`
        )
      }
      if (child.isDirectory()) {
        await visit(absolute)
        continue
      }
      logicalBytes = safeByteSum(logicalBytes, child.size)
    }
  }
  await visit(root)
  const maximumBytes =
    limits.diskBytes > 0 ? limits.diskBytes : MAX_UNLIMITED_RESTORE_BYTES
  if (logicalBytes > maximumBytes) {
    throw resticError(
      "restore_too_large",
      "restore.validate",
      "The backup expands beyond this server's disk limit"
    )
  }
  return { entries, logicalBytes }
}

type SpawnedRestic = {
  exitCode: number
  stderr: string
  stdout: NodeJS.ReadableStream
  stdoutText: string
}

async function spawnResticCommand(
  spawnRestic: ResticSpawn,
  binary: string,
  args: ReadonlyArray<string>,
  input: {
    cwd?: string
    onJson?: (value: unknown) => void
    password: string
    repository: string
    signal: AbortSignal
    stdout?: (chunk: Buffer) => void
  }
): Promise<SpawnedRestic> {
  input.signal.throwIfAborted()
  const child = spawnRestic(binary, [...args], {
    cwd: input.cwd,
    env: {
      ...process.env,
      RESTIC_CACHE_DIR: "",
      RESTIC_PASSWORD: input.password,
      RESTIC_REPOSITORY: input.repository,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (!child.stdout || !child.stderr) {
    throw resticError(
      "restic_stdio_missing",
      args[0] ?? "restic",
      "restic did not provide stdio pipes"
    )
  }
  const stdout = child.stdout
  const stderrStream = child.stderr
  let stdoutText = ""
  let stderr = ""
  let stdoutBuffer = ""
  const collectStdout = Boolean(input.onJson) && !input.stdout
  const onAbort = () => {
    child.kill("SIGTERM")
  }
  input.signal.addEventListener("abort", onAbort, { once: true })
  const completed = await resultOf(async () => {
    const [exitCode] = await Promise.all([
      new Promise<number>((resolveExit, rejectExit) => {
        child.once("error", rejectExit)
        child.once("close", (code) => resolveExit(code ?? 1))
      }),
      readStream(stdout, (chunk) => {
        if (input.stdout) {
          input.stdout(chunk)
          return
        }
        if (!collectStdout && !input.onJson) {
          stdoutText = appendBounded(stdoutText, chunk.toString("utf8"))
          return
        }
        stdoutBuffer += chunk.toString("utf8")
        stdoutText = appendBounded(stdoutText, chunk.toString("utf8"))
        const lines = stdoutBuffer.split("\n")
        stdoutBuffer = lines.pop() ?? ""
        for (const line of lines) {
          const parsed = parseResticJsonLine(line)
          if (parsed !== null) input.onJson?.(parsed)
        }
      }),
      readStream(stderrStream, (chunk) => {
        stderr = appendBounded(stderr, chunk.toString("utf8"), MAX_STDERR_BYTES)
      }),
    ])
    if (stdoutBuffer.trim()) {
      const parsed = parseResticJsonLine(stdoutBuffer)
      if (parsed !== null) input.onJson?.(parsed)
    }
    if (exitCode !== 0) {
      throw resticError(
        "restic_command_failed",
        args[0] ?? "restic",
        stderr.trim() || `restic exited with code ${exitCode}`
      )
    }
    return { exitCode, stderr, stdout, stdoutText }
  })
  input.signal.removeEventListener("abort", onAbort)
  if (Result.isFailure(completed)) throw completed.failure
  return completed.success
}

async function readStream(
  stream: NodeJS.ReadableStream,
  onChunk: (chunk: Buffer) => void
): Promise<void> {
  for await (const chunk of stream) {
    onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
}

function defaultSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    stdio: ["ignore", "pipe", "pipe"]
  }
): ChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: options.stdio,
  })
}

function isMissingSnapshotError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /no matching ID found/iu.test(message)
}

function resultOf<T>(run: () => Promise<T>) {
  return Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: run,
        catch: (cause) => cause,
      })
    )
  )
}

function resticError(code: string, operation: string, reason: string) {
  return RelayBackupError.make({ code, operation, reason })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : null
}

function integerField(
  value: Record<string, unknown>,
  key: string
): number | null {
  const field = value[key]
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
    ? field
    : null
}

function appendBounded(current: string, next: string, max = MAX_JSON_LINE_BYTES) {
  const combined = current + next
  return combined.length > max ? combined.slice(combined.length - max) : combined
}

function requireContained(root: string, candidate: string, operation: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw resticError(
      "path_outside_instance",
      operation,
      "The restore path resolves outside the instance directory"
    )
  }
}

function safeByteSum(total: number, value: number): number {
  const sum = total + value
  if (!Number.isSafeInteger(sum) || sum > MAX_UNLIMITED_RESTORE_BYTES) {
    throw resticError(
      "restore_too_large",
      "restore.validate",
      "The backup expands beyond the maximum supported restore size"
    )
  }
  return sum
}

export async function replaceFileAtomically(
  source: string,
  destination: string
): Promise<void> {
  await rename(source, destination)
}
