import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, resolve, sep } from "node:path"

import { Effect, Result } from "effect"

import {
  relayFileSyncActivationResultSchema,
  type RelayFileSyncActivate,
  type RelayFileSyncCleanup,
  type RelayFileSyncPrepare,
} from "@workspace/contracts"

import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import { RelayFilesystemError } from "./effect/errors.js"

const MARKER_NAME = ".kiln-sync.json"
const JOURNAL_VERSION = 1 as const
const PROTECTED_ROOTS = new Set([
  ".kiln",
  "backups",
  "crash-reports",
  "logs",
  "world",
  "world_nether",
  "world_the_end",
])

export interface FileSyncJournal {
  deploymentId: string
  deletions: Array<string>
  directories: Array<string>
  files: Array<string>
  instanceDirectory: string
  phase: "activating" | "committed"
  stagingPath: string
  version: typeof JOURNAL_VERSION
}

export class DeploymentFileSyncDriver {
  readonly #config: RelayConfig

  constructor(config: RelayConfig) {
    this.#config = config
  }

  prepare(instance: RelayInstanceConfig, input: RelayFileSyncPrepare) {
    return syncOperation("sync.prepare", async () => {
      const root = await instanceRoot(this.#config, instance)
      requireDeploymentPath(input.deploymentId, input.stagingPath)
      const staging = resolveContained(root, input.stagingPath)
      await createSafeDirectories(root, dirname(input.stagingPath))
      const created = await promiseResult(() => mkdir(staging, { mode: 0o700 }))
      if (Result.isFailure(created)) {
        if (errorCode(created.failure) === "EEXIST") {
          throw syncError(
            "staging_exists",
            "sync.prepare",
            "The deployment staging directory already exists"
          )
        }
        throw created.failure
      }
      const marked = await promiseResult(() =>
        writeFile(
          resolve(staging, MARKER_NAME),
          `${JSON.stringify(deploymentMarker(input.deploymentId))}\n`,
          { mode: 0o600 }
        )
      )
      if (Result.isFailure(marked)) {
        await rm(staging, { force: true, recursive: true })
        throw marked.failure
      }
      return {
        deploymentId: input.deploymentId,
        prepared: true as const,
        stagingPath: input.stagingPath,
      }
    })
  }

  activate(instance: RelayInstanceConfig, input: RelayFileSyncActivate) {
    return syncOperation("sync.activate", async () => {
      const root = await instanceRoot(this.#config, instance)
      const staging = await verifiedStagingRoot(root, input)
      if (input.deletions.length > input.maxDelete) {
        throw syncError(
          "delete_limit_exceeded",
          "sync.preflight",
          `Managed deletion count ${input.deletions.length} exceeds the requested maximum ${input.maxDelete}`
        )
      }
      validateAffectedPaths(input, input.stagingPath)
      await verifyActivation(root, staging, input)

      const journalPath = deploymentJournalPath(
        this.#config,
        input.deploymentId
      )
      const journal: FileSyncJournal = {
        deploymentId: input.deploymentId,
        deletions: input.deletions.map((entry) => entry.path),
        directories: [...input.directories],
        files: input.files.map((entry) => entry.path),
        instanceDirectory: instance.directory,
        phase: "activating",
        stagingPath: input.stagingPath,
        version: JOURNAL_VERSION,
      }
      await mkdir(dirname(journalPath), { mode: 0o700, recursive: true })
      await writeJournal(journalPath, journal)
      let committed = false

      const activation = await promiseResult(async () => {
        for (const directory of input.directories) {
          await createSafeDirectories(root, directory)
        }
        for (const file of input.files) {
          await createSafeDirectories(root, dirname(file.path))
          const destination = await anchoredDestination(root, file.path)
          const rollback = rollbackPath(staging, file.path)
          if (await pathExists(destination)) {
            await createSafeDirectories(
              staging,
              dirname(relativeRollback(file.path))
            )
            await rename(destination, rollback)
          }
          const staged = await regularFile(
            staging,
            stagedFilePath(staging, file.path),
            "sync.activate"
          )
          await rename(staged.path, destination)
        }
        for (const deletion of input.deletions) {
          const source = await regularFile(
            root,
            resolveContained(root, deletion.path),
            "sync.delete"
          )
          const rollback = rollbackPath(staging, deletion.path)
          await createSafeDirectories(
            staging,
            dirname(relativeRollback(deletion.path))
          )
          await rename(source.path, rollback)
        }

        const committedJournal = { ...journal, phase: "committed" as const }
        await writeJournal(journalPath, committedJournal)
        committed = true
        await settleFileSyncJournal(this.#config, committedJournal, true)
        return relayFileSyncActivationResultSchema.parse({
          activated: journal.files,
          deleted: journal.deletions,
          deploymentId: input.deploymentId,
          stagingPath: input.stagingPath,
        })
      })
      if (Result.isFailure(activation)) {
        if (committed) {
          throw syncError(
            "cleanup_failed",
            "sync.cleanup",
            "Deployment activated but Relay could not finish staging cleanup",
            activation.failure
          )
        }
        const rollback = await promiseResult(() =>
          settleFileSyncJournal(this.#config, journal, false)
        )
        if (Result.isFailure(rollback)) {
          throw syncError(
            "rollback_failed",
            "sync.rollback",
            "File sync activation failed and Relay could not restore the previous files",
            rollback.failure
          )
        }
        throw activation.failure
      }
      return activation.success
    })
  }

  cleanup(instance: RelayInstanceConfig, input: RelayFileSyncCleanup) {
    return syncOperation("sync.cleanup", async () => {
      const root = await instanceRoot(this.#config, instance)
      requireDeploymentPath(input.deploymentId, input.stagingPath)
      const staging = resolveContained(root, input.stagingPath)
      if (!(await pathExists(staging))) {
        return { ...input, cleaned: false }
      }
      const verified = await verifiedStagingRoot(root, input)
      await rm(verified, { force: true, recursive: true })
      return { ...input, cleaned: true }
    })
  }

  recover() {
    return syncOperation("sync.recover", () =>
      recoverInterruptedFileSyncs(this.#config)
    )
  }
}

export async function recoverInterruptedFileSyncs(
  config: RelayConfig
): Promise<Array<string>> {
  const directory = deploymentJournalDirectory(config)
  await mkdir(directory, { mode: 0o700, recursive: true })
  const recovered: Array<string> = []
  for await (const entry of await opendir(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const path = resolve(directory, entry.name)
    const journal = parseJournal(await readFile(path, "utf8"))
    if (!journal || `${journal.deploymentId}.json` !== entry.name) {
      throw syncError(
        "invalid_journal",
        "sync.recover",
        `File sync recovery journal ${entry.name} is invalid`
      )
    }
    await settleFileSyncJournal(config, journal, journal.phase === "committed")
    recovered.push(journal.deploymentId)
  }
  return recovered
}

export async function settleFileSyncJournal(
  config: RelayConfig,
  journal: FileSyncJournal,
  preferComplete: boolean
): Promise<void> {
  const root = resolve(config.rootDirectory, journal.instanceDirectory)
  const journalPath = deploymentJournalPath(config, journal.deploymentId)
  if (!(await pathExists(root))) {
    throw syncError(
      "rollback_failed",
      "sync.recover",
      "Deployment instance directory is missing; recovery evidence was preserved"
    )
  }
  const actualRoot = await realpath(root)
  requireContained(await realpath(config.rootDirectory), actualRoot)
  const requestedStaging = resolveContained(actualRoot, journal.stagingPath)
  const stagingExists = await pathExists(requestedStaging)

  if (preferComplete || journal.phase === "committed") {
    if (stagingExists) {
      const staging = await verifiedJournalStaging(actualRoot, requestedStaging)
      await rm(staging, { force: true, recursive: true })
    }
    await rm(journalPath, { force: true })
    return
  }
  if (!stagingExists) {
    throw syncError(
      "rollback_failed",
      "sync.recover",
      "Deployment rollback data is missing"
    )
  }
  const staging = await verifiedJournalStaging(actualRoot, requestedStaging)

  for (const path of [...journal.deletions].reverse()) {
    const rollback = rollbackPath(staging, path)
    if (!(await pathExists(rollback))) continue
    await createSafeDirectories(actualRoot, dirname(path))
    const destination = await anchoredDestination(actualRoot, path)
    await rm(destination, { force: true, recursive: true })
    await rename(rollback, destination)
  }
  for (const path of [...journal.files].reverse()) {
    const rollback = rollbackPath(staging, path)
    const staged = stagedFilePath(staging, path)
    if (await pathExists(rollback)) {
      await createSafeDirectories(actualRoot, dirname(path))
      const destination = await anchoredDestination(actualRoot, path)
      await rm(destination, { force: true, recursive: true })
      await rename(rollback, destination)
    } else if (!(await pathExists(staged))) {
      const destination = await anchoredDestination(actualRoot, path)
      if (await pathExists(destination)) {
        await rm(destination, { force: true, recursive: true })
      }
    }
  }
  for (const path of [...journal.directories].sort(
    (left, right) => right.split("/").length - left.split("/").length
  )) {
    const removed = await promiseResult(() =>
      rmdir(resolveContained(actualRoot, path))
    )
    if (
      Result.isFailure(removed) &&
      !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
        errorCode(removed.failure) ?? ""
      )
    ) {
      throw removed.failure
    }
  }
  await rm(staging, { force: true, recursive: true })
  await rm(journalPath, { force: true })
}

async function verifiedJournalStaging(
  root: string,
  staging: string
): Promise<string> {
  const metadata = await lstat(staging)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw syncError(
      "invalid_staging",
      "sync.recover",
      "Deployment rollback path is not a regular directory"
    )
  }
  const actual = await realpath(staging)
  requireContained(root, actual)
  return actual
}

async function verifyActivation(
  root: string,
  staging: string,
  input: RelayFileSyncActivate
): Promise<void> {
  const plannedDirectories = new Set(input.directories)
  for (const directory of input.directories) {
    const target = resolveContained(root, directory)
    if (await pathExists(target)) {
      throw syncError(
        "target_changed",
        "sync.preflight",
        `Remote directory ${directory} appeared after the deployment plan was created`
      )
    }
    await requireSafeExistingParent(root, dirname(directory))
  }
  for (const file of input.files) {
    const staged = stagedFilePath(staging, file.path)
    const verified = await regularFile(staging, staged, "sync.verify")
    if (
      verified.metadata.size !== file.size ||
      (await hashFile(verified.path)) !== file.sha256
    ) {
      throw syncError(
        "verification_failed",
        "sync.verify",
        `Staged file ${file.path} does not match its deployment plan`
      )
    }
    await requirePlannedDirectories(
      root,
      dirname(file.path),
      plannedDirectories
    )
    await verifyTarget(root, file.path, file.expectedTarget)
  }
  for (const deletion of input.deletions) {
    await requireDeletable(root, deletion.path)
    await verifyTarget(root, deletion.path, {
      sha256: deletion.sha256,
      size: deletion.size,
    })
  }
}

async function requirePlannedDirectories(
  root: string,
  requested: string,
  plannedDirectories: ReadonlySet<string>
): Promise<void> {
  if (!requested || requested === ".") return
  const segments = requested.split("/")
  for (let index = 1; index <= segments.length; index += 1) {
    const directory = segments.slice(0, index).join("/")
    if (
      !(await pathExists(resolveContained(root, directory))) &&
      !plannedDirectories.has(directory)
    ) {
      throw syncError(
        "unplanned_directory",
        "sync.preflight",
        `Remote directory ${directory} is required but was not included in the deployment plan`
      )
    }
  }
}

async function verifyTarget(
  root: string,
  path: string,
  expected: { sha256?: string; size?: number } | null
): Promise<void> {
  const target = resolveContained(root, path)
  const exists = await pathExists(target)
  if (expected === null) {
    if (exists) {
      throw syncError(
        "target_changed",
        "sync.preflight",
        `Remote file ${path} appeared after the deployment plan was created`
      )
    }
    await requireSafeExistingParent(root, dirname(path))
    return
  }
  if (!exists) {
    throw syncError(
      "target_changed",
      "sync.preflight",
      `Remote file ${path} disappeared after the deployment plan was created`
    )
  }
  const verified = await regularFile(root, target, "sync.preflight")
  if (expected.size !== undefined && verified.metadata.size !== expected.size) {
    throw syncError(
      "target_changed",
      "sync.preflight",
      `Remote file ${path} changed after the deployment plan was created`
    )
  }
  if (expected.sha256 && (await hashFile(verified.path)) !== expected.sha256) {
    throw syncError(
      "target_changed",
      "sync.preflight",
      `Remote file ${path} changed after the deployment plan was created`
    )
  }
}

function validateAffectedPaths(
  input: RelayFileSyncActivate,
  stagingPath: string
): void {
  const paths = [
    ...input.directories,
    ...input.files.map((file) => file.path),
    ...input.deletions.map((file) => file.path),
  ]
  if (new Set(paths).size !== paths.length) {
    throw syncError(
      "duplicate_path",
      "sync.preflight",
      "A deployment path may only be activated or deleted once"
    )
  }
  for (const path of paths) {
    if (
      path === stagingPath ||
      path.startsWith(`${stagingPath}/`) ||
      stagingPath.startsWith(`${path}/`)
    ) {
      throw syncError(
        "invalid_path",
        "sync.preflight",
        "Deployment targets cannot overlap the staging directory"
      )
    }
  }
}

async function requireDeletable(root: string, path: string): Promise<void> {
  const rootName = path.split("/")[0]?.toLowerCase() ?? ""
  if (PROTECTED_ROOTS.has(rootName)) {
    throw syncError(
      "protected_path",
      "sync.delete",
      `Managed deletion cannot remove protected path ${path}`
    )
  }
  const segments = path.split("/")
  segments.pop()
  for (let index = segments.length; index >= 1; index -= 1) {
    const directory = resolveContained(root, segments.slice(0, index).join("/"))
    if (await pathExists(resolve(directory, "level.dat"))) {
      throw syncError(
        "protected_path",
        "sync.delete",
        `Managed deletion cannot remove world data at ${path}`
      )
    }
  }
}

async function verifiedStagingRoot(
  root: string,
  input: { deploymentId: string; stagingPath: string }
): Promise<string> {
  requireDeploymentPath(input.deploymentId, input.stagingPath)
  const staging = resolveContained(root, input.stagingPath)
  const metadata = await lstat(staging)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw syncError(
      "invalid_staging",
      "sync.staging",
      "Deployment staging path is not a regular directory"
    )
  }
  const actual = await realpath(staging)
  requireContained(root, actual)
  await verifyDeploymentMarker(actual, input.deploymentId)
  return actual
}

async function verifyDeploymentMarker(
  staging: string,
  deploymentId: string
): Promise<void> {
  const markerPath = resolve(staging, MARKER_NAME)
  const metadata = await lstat(markerPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw syncError(
      "invalid_staging",
      "sync.staging",
      "Deployment staging marker is invalid"
    )
  }
  const marker = await readFile(markerPath, "utf8")
  if (marker !== `${JSON.stringify(deploymentMarker(deploymentId))}\n`) {
    throw syncError(
      "invalid_staging",
      "sync.staging",
      "Deployment staging marker does not match this deployment"
    )
  }
}

function deploymentMarker(deploymentId: string) {
  return { deploymentId, type: "kiln.files.sync", version: 1 }
}

function requireDeploymentPath(
  deploymentId: string,
  stagingPath: string
): void {
  validateRelativePath(stagingPath)
  if (basename(stagingPath) !== deploymentId) {
    throw syncError(
      "invalid_staging",
      "sync.staging",
      "Staging path must end with the deployment ID"
    )
  }
}

async function instanceRoot(
  config: RelayConfig,
  instance: RelayInstanceConfig
): Promise<string> {
  const configuredRoot = await realpath(config.rootDirectory)
  const root = await realpath(resolve(configuredRoot, instance.directory))
  requireContained(configuredRoot, root)
  return root
}

async function createSafeDirectories(root: string, requested: string) {
  if (!requested || requested === ".") return
  validateRelativePath(requested)
  let current = root
  for (const segment of requested.split("/")) {
    current = resolve(current, segment)
    requireContained(root, current)
    const inspected = await promiseResult(() => lstat(current))
    if (Result.isSuccess(inspected)) {
      const metadata = inspected.success
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw syncError(
          "not_a_directory",
          "sync.path",
          "A deployment parent is not a regular directory"
        )
      }
    } else {
      if (errorCode(inspected.failure) !== "ENOENT") throw inspected.failure
      await mkdir(current, { mode: 0o755 })
    }
  }
}

async function requireSafeExistingParent(root: string, requested: string) {
  if (!requested || requested === ".") return
  validateRelativePath(requested)
  let current = root
  for (const segment of requested.split("/")) {
    current = resolve(current, segment)
    requireContained(root, current)
    const inspected = await promiseResult(() => lstat(current))
    if (Result.isSuccess(inspected)) {
      const metadata = inspected.success
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw syncError(
          "not_a_directory",
          "sync.path",
          "A deployment parent is not a regular directory"
        )
      }
    } else {
      if (errorCode(inspected.failure) === "ENOENT") return
      throw inspected.failure
    }
  }
}

async function regularFile(root: string, path: string, operation: string) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw syncError(
      "unsupported_file",
      operation,
      "Deployment entries must be regular files"
    )
  }
  const actual = await realpath(path)
  requireContained(root, actual)
  return { metadata, path: actual }
}

async function anchoredDestination(root: string, path: string) {
  validateRelativePath(path)
  const parent = await realpath(resolve(root, dirname(path)))
  requireContained(root, parent)
  return resolve(parent, basename(path))
}

function stagedFilePath(staging: string, path: string): string {
  return resolveContained(staging, `files/${path}`)
}

function relativeRollback(path: string): string {
  return `.rollback/${path}`
}

function rollbackPath(staging: string, path: string): string {
  return resolveContained(staging, relativeRollback(path))
}

function resolveContained(root: string, path: string): string {
  validateRelativePath(path)
  const candidate = resolve(root, ...path.split("/"))
  requireContained(root, candidate)
  return candidate
}

function requireContained(root: string, candidate: string): void {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw syncError(
      "path_outside_instance",
      "sync.path",
      "Deployment path resolves outside the instance directory"
    )
  }
}

function validateRelativePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw syncError("invalid_path", "sync.path", "Invalid relative path")
  }
}

function deploymentJournalDirectory(config: RelayConfig): string {
  return resolve(config.dataDirectory, "file-sync")
}

function deploymentJournalPath(config: RelayConfig, deploymentId: string) {
  return resolve(deploymentJournalDirectory(config), `${deploymentId}.json`)
}

async function writeJournal(path: string, journal: FileSyncJournal) {
  await Effect.runPromise(
    writeFileAtomic(path, `${JSON.stringify(journal)}\n`, 0o600)
  )
}

function parseJournal(value: string): FileSyncJournal | null {
  const decoded = Result.try(
    () => JSON.parse(value) as Partial<FileSyncJournal>
  )
  if (Result.isFailure(decoded)) return null
  const parsed = decoded.success
  if (
    parsed.version !== JOURNAL_VERSION ||
    !parsed.deploymentId ||
    !/^[0-9a-f-]{36}$/iu.test(parsed.deploymentId) ||
    !parsed.instanceDirectory ||
    !parsed.stagingPath ||
    !Array.isArray(parsed.files) ||
    !parsed.files.every((path) => typeof path === "string") ||
    !Array.isArray(parsed.deletions) ||
    !parsed.deletions.every((path) => typeof path === "string") ||
    !Array.isArray(parsed.directories) ||
    !parsed.directories.every((path) => typeof path === "string") ||
    !["activating", "committed"].includes(parsed.phase ?? "")
  ) {
    return null
  }
  return parsed as FileSyncJournal
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", () => resolvePromise(hash.digest("hex")))
  })
}

async function pathExists(path: string): Promise<boolean> {
  const inspected = await promiseResult(() => lstat(path))
  if (Result.isSuccess(inspected)) return true
  if (errorCode(inspected.failure) === "ENOENT") return false
  throw inspected.failure
}

function promiseResult<TResult>(run: () => Promise<TResult>) {
  return Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: run, catch: (cause) => cause }))
  )
}

function syncOperation<TResult>(
  operation: string,
  run: () => Promise<TResult>
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof RelayFilesystemError
        ? cause
        : syncError("io_error", operation, errorMessage(cause), cause),
  })
}

function syncError(
  code: string,
  operation: string,
  reason: string,
  cause?: unknown
) {
  return RelayFilesystemError.make({
    code,
    operation,
    reason,
    ...(cause === undefined ? {} : { cause }),
  })
}

function errorCode(cause: unknown): string | undefined {
  return cause && typeof cause === "object" && "code" in cause
    ? String(cause.code)
    : undefined
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Filesystem operation failed"
}
