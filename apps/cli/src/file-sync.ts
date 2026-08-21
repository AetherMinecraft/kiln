import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve } from "node:path"

import { Effect, Result } from "effect"
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2"

import { CliCommandError, commandError } from "./errors.js"
import { formatBytes, writeLine, writeTable } from "./output.js"
import { resolveRemotePath } from "./sftp.js"
import {
  fileSyncManifestSchema,
  type RelayFileSyncActivate,
  type RelayFileSyncActivationResult,
  type RelayFileSyncCleanup,
  type RelayFileSyncPrepare,
} from "@workspace/contracts"

const MAX_SYNC_ENTRIES = 100_000
const HASH_CONCURRENCY = 4
// Remote work is latency-bound, not CPU-bound: one directory listing is a
// round trip to the Relay, and a server's plugin folder runs to hundreds of
// directories. Walking those one at a time spends the whole deploy waiting, so
// the transport gets its own, wider limit than local hashing.
//
// 16 rather than higher because a remote hash streams the whole file: against a
// live game server, 32 measured only ~12% better while doubling the concurrent
// reads competing with the server's own disk.
const REMOTE_CONCURRENCY = 16
const TRANSFER_CONCURRENCY = 4
const MAX_ATOMIC_CHANGES = 2_000
const DEFAULT_STAGING_BASE = ".kiln/deployments"
const PROTECTED_DELETE_ROOTS = new Set([
  ".kiln",
  "backups",
  "crash-reports",
  "logs",
  "world",
  "world_nether",
  "world_the_end",
])

export interface FileSyncTransport {
  hash(path: string): Promise<string>
  list(path: string): Promise<ReadonlyArray<RemoteSyncEntry>>
  mkdir(path: string): Promise<void>
  stat(path: string): Promise<RemoteSyncEntry>
  upload(localPath: string, remotePath: string): Promise<void>
}

export interface RemoteSyncEntry {
  kind: "directory" | "file" | "symlink" | "unsupported"
  name: string
  size: number
}

export interface FileSyncController {
  activate(
    input: RelayFileSyncActivate
  ): Effect.Effect<RelayFileSyncActivationResult, CliCommandError>
  cleanup(input: RelayFileSyncCleanup): Effect.Effect<unknown, CliCommandError>
  prepare(input: RelayFileSyncPrepare): Effect.Effect<unknown, CliCommandError>
}

interface LocalSyncFile {
  absolutePath: string
  path: string
  sha256: string
  size: number
}

export interface FileSyncPlan {
  atomic: boolean
  createDirectories: Array<string>
  excluded: Array<string>
  excludes: Array<string>
  deleteManaged: boolean
  deletions: Array<{ path: string; sha256: string; size: number }>
  deploymentId: string | null
  instanceId: string | null
  localDirectory: string
  manifest: string | null
  maxDelete: number
  stagingPath: string | null
  summary: {
    createDirectories: number
    deleteBytes: number
    deleteFiles: number
    excluded: number
    localBytes: number
    localFiles: number
    remoteFiles: number
    unchangedFiles: number
    uploadBytes: number
    uploadFiles: number
  }
  unchanged: Array<{
    path: string
    sha256: string
    size: number
  }>
  upload: Array<{
    path: string
    reason: "hash_changed" | "missing" | "size_changed"
    remoteSha256?: string
    remoteSize?: number
    expectedTarget: { sha256?: string; size?: number } | null
    sha256: string
    size: number
  }>
}

export interface FileSyncOutput {
  mode: "plan" | "sync"
  plan: FileSyncPlan
  result: {
    bytesTransferred: number
    activated: Array<string>
    createdDirectories: Array<string>
    deleted: Array<string>
    status: "planned" | "succeeded"
    uploaded: Array<{ path: string; sha256: string; size: number }>
    verifiedFiles: number
    stagingPath: string | null
  }
  server: string
  type: "files.sync"
  version: 2
}

interface AppliedFileSyncResult {
  activated: Array<string>
  bytesTransferred: number
  createdDirectories: Array<string>
  deleted: Array<string>
  uploaded: Array<{ path: string; sha256: string; size: number }>
  verifiedFiles: number
  stagingPath: string | null
}

export const runFileSyncEffect = Effect.fn("cli.files.sync")(function* (input: {
  atomic?: boolean
  controller?: FileSyncController
  deleteManaged?: boolean
  excludes: ReadonlyArray<string>
  localDirectory: string
  instanceId?: string
  manifest?: string
  maxDelete?: number
  planOnly: boolean
  server: string
  stagingBase?: string
  transport: FileSyncTransport
}) {
  const atomic = input.atomic ?? false
  const deploymentId = atomic ? randomUUID() : null
  const stagingPath = deploymentId
    ? yield* Effect.try({
        try: () => deploymentStagingPath(input.stagingBase, deploymentId),
        catch: (cause) =>
          cause instanceof CliCommandError
            ? cause
            : syncPlanningError("Invalid remote staging path."),
      })
    : null
  const plan = yield* buildFileSyncPlanEffect({
    ...input,
    atomic,
    deploymentId,
    stagingPath,
  })
  if (input.planOnly) return fileSyncOutput(input.server, plan, null)

  const result = plan.atomic
    ? yield* applyAtomicFileSyncPlanEffect(
        plan,
        input.transport,
        input.controller
      )
    : yield* applyFileSyncPlanEffect(plan, input.transport)
  return fileSyncOutput(input.server, plan, result)
})

export const buildFileSyncPlanEffect = Effect.fn("cli.files.sync.plan")(
  function* (input: {
    excludes: ReadonlyArray<string>
    localDirectory: string
    atomic?: boolean
    deleteManaged?: boolean
    deploymentId?: string | null
    instanceId?: string
    manifest?: string
    maxDelete?: number
    stagingPath?: string | null
    transport: FileSyncTransport
  }) {
    const atomic = input.atomic ?? false
    const deleteManaged = input.deleteManaged ?? false
    const maxDelete = input.maxDelete ?? 0
    const stagingBase = input.stagingPath
      ? input.stagingPath.split("/").slice(0, -1).join("/")
      : DEFAULT_STAGING_BASE
    if (deleteManaged && !atomic) {
      return yield* syncPlanningError("Managed deletion requires atomic sync.")
    }
    if (deleteManaged && !input.manifest) {
      return yield* syncPlanningError(
        "Managed deletion requires a versioned manifest."
      )
    }
    if (!Number.isInteger(maxDelete) || maxDelete < 0) {
      return yield* syncPlanningError("Maximum deletion count is invalid.")
    }
    const inventory = yield* planningOperation(() =>
      readLocalInventory(input.localDirectory, input.excludes, stagingBase)
    )
    const remote = yield* planningOperation(() =>
      readRemoteInventory(input.transport, stagingBase, input.excludes)
    )
    const manifest = input.manifest
      ? yield* planningOperation(() =>
          readManagedManifest(input.manifest as string)
        )
      : null

    const createDirectories: Array<string> = []
    for (const directory of inventory.directories) {
      const remoteEntry = remote.entries.get(directory)
      if (remoteEntry && remoteEntry.kind !== "directory") {
        return yield* syncPlanningError(
          `Remote path ${directory} is not a directory.`
        )
      }
      if (!remoteEntry) createDirectories.push(directory)
    }

    const unchanged: FileSyncPlan["unchanged"] = []
    const upload: FileSyncPlan["upload"] = []
    const sameSize: Array<{
      file: LocalSyncFile
      remote: RemoteSyncEntry
    }> = []
    for (const file of inventory.files) {
      const remoteEntry = remote.entries.get(file.path)
      if (!remoteEntry) {
        upload.push(uploadEntry(file, "missing", { expectedTarget: null }))
        continue
      }
      if (remoteEntry.kind !== "file") {
        return yield* syncPlanningError(
          `Remote path ${file.path} is ${remoteEntry.kind}; refusing to replace it.`
        )
      }
      if (remoteEntry.size !== file.size) {
        upload.push(
          uploadEntry(file, "size_changed", {
            expectedTarget: { size: remoteEntry.size },
            remoteSize: remoteEntry.size,
          })
        )
        continue
      }
      sameSize.push({ file, remote: remoteEntry })
    }

    const compared = yield* planningOperation(() =>
      mapConcurrent(sameSize, REMOTE_CONCURRENCY, async ({ file, remote }) => {
        const remoteSha256 = await input.transport.hash(file.path)
        return { file, remote, remoteSha256 }
      })
    )
    for (const { file, remote, remoteSha256 } of compared) {
      if (remoteSha256 === file.sha256) {
        unchanged.push({
          path: file.path,
          sha256: file.sha256,
          size: file.size,
        })
      } else {
        upload.push(
          uploadEntry(file, "hash_changed", {
            expectedTarget: { sha256: remoteSha256, size: remote.size },
            remoteSha256,
            remoteSize: remote.size,
          })
        )
      }
    }

    const deletions = deleteManaged
      ? yield* planningOperation(() =>
          planManagedDeletions({
            excludes: input.excludes,
            localFiles: inventory.files,
            manifest,
            maxDelete,
            remote: remote.entries,
            transport: input.transport,
          })
        )
      : []
    if (
      atomic &&
      upload.length + deletions.length + createDirectories.length >
        MAX_ATOMIC_CHANGES
    ) {
      return yield* syncPlanningError(
        `Atomic deployments can affect at most ${MAX_ATOMIC_CHANGES} files.`
      )
    }

    createDirectories.sort(pathDepthOrder)
    unchanged.sort(comparePath)
    upload.sort(comparePath)
    const localBytes = inventory.files.reduce(
      (total, file) => total + file.size,
      0
    )
    const uploadBytes = upload.reduce((total, file) => total + file.size, 0)
    const deleteBytes = deletions.reduce((total, file) => total + file.size, 0)
    return {
      atomic,
      createDirectories,
      deleteManaged,
      deletions,
      deploymentId: input.deploymentId ?? null,
      excluded: inventory.excluded,
      excludes: [...input.excludes],
      instanceId: input.instanceId ?? null,
      localDirectory: inventory.root,
      manifest: manifest?.path ?? null,
      maxDelete,
      stagingPath: input.stagingPath ?? null,
      summary: {
        createDirectories: createDirectories.length,
        deleteBytes,
        deleteFiles: deletions.length,
        excluded: inventory.excluded.length,
        localBytes,
        localFiles: inventory.files.length,
        remoteFiles: [...remote.entries.values()].filter(
          (entry) => entry.kind === "file"
        ).length,
        unchangedFiles: unchanged.length,
        uploadBytes,
        uploadFiles: upload.length,
      },
      unchanged,
      upload,
    } satisfies FileSyncPlan
  }
)

export const applyFileSyncPlanEffect = Effect.fn("cli.files.sync.apply")(
  function* (plan: FileSyncPlan, transport: FileSyncTransport) {
    for (const directory of plan.createDirectories) {
      yield* transferOperation(
        () => transport.mkdir(directory),
        `Could not create remote directory ${directory}.`
      )
    }

    const uploaded = yield* Effect.forEach(
      plan.upload,
      (file) =>
        Effect.gen(function* () {
          const localPath = yield* Effect.try({
            try: () => resolveLocalPlanPath(plan.localDirectory, file.path),
            catch: (cause) =>
              cause instanceof CliCommandError
                ? cause
                : syncPlanningError(`Invalid sync plan path: ${file.path}`),
          })
          yield* transferOperation(
            () => transport.upload(localPath, file.path),
            `Could not upload ${file.path}.`
          )
          const metadata = yield* verificationOperation(
            () => transport.stat(file.path),
            `Could not inspect uploaded file ${file.path}.`
          )
          if (metadata.kind !== "file" || metadata.size !== file.size) {
            return yield* syncVerificationError(
              `Uploaded file ${file.path} has size ${metadata.size}; expected ${file.size}.`
            )
          }
          const sha256 = yield* verificationOperation(
            () => transport.hash(file.path),
            `Could not hash uploaded file ${file.path}.`
          )
          if (sha256 !== file.sha256) {
            return yield* syncVerificationError(
              `Uploaded file ${file.path} failed SHA-256 verification.`
            )
          }
          return { path: file.path, sha256, size: file.size }
        }),
      { concurrency: TRANSFER_CONCURRENCY }
    )

    return {
      activated: uploaded.map((file) => file.path),
      bytesTransferred: uploaded.reduce((total, file) => total + file.size, 0),
      createdDirectories: [...plan.createDirectories],
      deleted: [],
      stagingPath: null,
      uploaded,
      verifiedFiles: uploaded.length,
    }
  }
)

export const applyAtomicFileSyncPlanEffect = Effect.fn("cli.files.sync.atomic")(
  function* (
    plan: FileSyncPlan,
    transport: FileSyncTransport,
    controller: FileSyncController | undefined
  ) {
    if (
      !controller ||
      !plan.deploymentId ||
      !plan.instanceId ||
      !plan.stagingPath
    ) {
      return yield* syncActivationError(
        "Atomic file sync requires a Relay activation controller."
      )
    }
    if (
      plan.upload.length === 0 &&
      plan.deletions.length === 0 &&
      plan.createDirectories.length === 0
    ) {
      return {
        activated: [],
        bytesTransferred: 0,
        createdDirectories: [],
        deleted: [],
        stagingPath: plan.stagingPath,
        uploaded: [],
        verifiedFiles: 0,
      } satisfies AppliedFileSyncResult
    }
    const deployment = {
      deploymentId: plan.deploymentId,
      instanceId: plan.instanceId,
      stagingPath: plan.stagingPath,
    }
    const operation = Effect.gen(function* () {
      yield* controllerOperation(
        controller.prepare({
          ...deployment,
          deleteManaged: plan.deleteManaged,
        }),
        "Relay could not prepare the deployment staging directory."
      )
      for (const directory of atomicStagingDirectories(plan)) {
        yield* transferOperation(
          () => transport.mkdir(directory),
          `Could not create staging directory ${directory}.`
        )
      }

      const uploaded = yield* Effect.forEach(
        plan.upload,
        (file) =>
          Effect.gen(function* () {
            const localPath = resolveLocalPlanPath(
              plan.localDirectory,
              file.path
            )
            const stagedPath = `${plan.stagingPath}/files/${file.path}`
            yield* transferOperation(
              () => transport.upload(localPath, stagedPath),
              `Could not stage ${file.path}.`
            )
            const metadata = yield* verificationOperation(
              () => transport.stat(stagedPath),
              `Could not inspect staged file ${file.path}.`
            )
            if (metadata.kind !== "file" || metadata.size !== file.size) {
              return yield* syncVerificationError(
                `Staged file ${file.path} has size ${metadata.size}; expected ${file.size}.`
              )
            }
            const sha256 = yield* verificationOperation(
              () => transport.hash(stagedPath),
              `Could not hash staged file ${file.path}.`
            )
            if (sha256 !== file.sha256) {
              return yield* syncVerificationError(
                `Staged file ${file.path} failed SHA-256 verification.`
              )
            }
            return { path: file.path, sha256, size: file.size }
          }),
        { concurrency: TRANSFER_CONCURRENCY }
      )

      const activated = yield* controllerOperation(
        controller.activate({
          ...deployment,
          deletions: plan.deletions,
          directories: plan.createDirectories,
          files: plan.upload.map((file) => ({
            expectedTarget: file.expectedTarget,
            path: file.path,
            sha256: file.sha256,
            size: file.size,
          })),
          maxDelete: plan.maxDelete,
        }),
        "Relay could not activate the staged deployment."
      )
      return {
        activated: activated.activated,
        bytesTransferred: uploaded.reduce(
          (total, file) => total + file.size,
          0
        ),
        createdDirectories: [...plan.createDirectories],
        deleted: activated.deleted,
        stagingPath: plan.stagingPath,
        uploaded,
        verifiedFiles: uploaded.length,
      } satisfies AppliedFileSyncResult
    })

    return yield* operation.pipe(
      Effect.tapError(() =>
        controllerOperation(
          controller.cleanup(deployment),
          "Relay could not clean the failed deployment staging directory."
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("File sync staging cleanup failed", cause)
          )
        )
      )
    )
  }
)

export function createSftpFileSyncTransport(
  sftp: SFTPWrapper,
  root: string
): FileSyncTransport {
  const remotePath = (path: string) =>
    path ? resolveRemotePath(root, path) : root
  return {
    hash: (path) => hashSftpFile(sftp, remotePath(path)),
    list: (path) =>
      sftpList(sftp, remotePath(path)).then((entries) =>
        entries.map(remoteEntry)
      ),
    mkdir: (path) =>
      sftpCallback((done) =>
        sftp.mkdir(remotePath(path), { mode: 0o755 }, done)
      ),
    stat: (path) =>
      sftpValue<Stats>((done) => sftp.lstat(remotePath(path), done)).then(
        (details) => remoteEntry({ attrs: details, filename: basename(path) })
      ),
    upload: (localPath, path) =>
      sftpCallback((done) => sftp.fastPut(localPath, remotePath(path), done)),
  }
}

export function renderFileSyncHuman(output: FileSyncOutput): void {
  const { plan } = output
  writeLine(
    `File sync ${output.mode === "plan" ? "plan" : "result"} for ${output.server}`
  )
  writeLine(`Local directory: ${plan.localDirectory}`)
  writeLine(
    `Upload: ${plan.summary.uploadFiles} files (${formatBytes(plan.summary.uploadBytes)}); unchanged: ${plan.summary.unchangedFiles}; create directories: ${plan.summary.createDirectories}.`
  )
  if (plan.atomic) {
    writeLine(`Atomic staging: ${plan.stagingPath ?? "unavailable"}.`)
  }
  if (plan.upload.length > 0) {
    const visible = plan.upload.slice(0, 200)
    writeTable(
      ["PATH", "SIZE", "REASON"],
      visible.map((file) => [file.path, formatBytes(file.size), file.reason])
    )
    if (visible.length < plan.upload.length) {
      writeLine(`Showing ${visible.length} of ${plan.upload.length} uploads.`)
    }
  }
  if (plan.deletions.length > 0) {
    const visible = plan.deletions.slice(0, 200)
    writeTable(
      ["DELETE MANAGED PATH", "SIZE"],
      visible.map((file) => [file.path, formatBytes(file.size)])
    )
    if (visible.length < plan.deletions.length) {
      writeLine(
        `Showing ${visible.length} of ${plan.deletions.length} managed deletions.`
      )
    }
  }
  if (output.result.status === "planned") {
    writeLine("Plan only; no remote files changed.")
  } else {
    writeLine(
      `Uploaded and verified ${output.result.verifiedFiles} files (${formatBytes(output.result.bytesTransferred)}).`
    )
    if (output.result.deleted.length > 0) {
      writeLine(`Deleted ${output.result.deleted.length} managed files.`)
    }
  }
}

async function readLocalInventory(
  localDirectory: string,
  patterns: ReadonlyArray<string>,
  stagingBase: string
) {
  const root = resolve(localDirectory)
  const rootMetadata = await lstat(root)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(
      "The local sync source must be a regular directory, not a symlink."
    )
  }
  const excludes = patterns.map(compileExcludePattern)
  const directories: Array<string> = []
  const excluded: Array<string> = []
  const pendingFiles: Array<{
    absolutePath: string
    path: string
    size: number
  }> = []

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (matchesAnyExclude(path, excludes)) {
        excluded.push(entry.isDirectory() ? `${path}/` : path)
        continue
      }
      if (path === stagingBase || path.startsWith(`${stagingBase}/`)) {
        throw new Error(
          `${stagingBase} is reserved for Kiln deployment staging.`
        )
      }
      if (directories.length + pendingFiles.length >= MAX_SYNC_ENTRIES) {
        throw new Error(
          `Local sync source exceeds ${MAX_SYNC_ENTRIES} entries.`
        )
      }
      const absolutePath = resolve(directory, entry.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
        throw new Error(`Local sync path ${path} is a symlink.`)
      }
      if (metadata.isDirectory()) {
        directories.push(path)
        await visit(absolutePath, path)
      } else if (metadata.isFile()) {
        pendingFiles.push({ absolutePath, path, size: metadata.size })
      } else {
        throw new Error(
          `Local sync path ${path} is not a regular file or directory.`
        )
      }
    }
  }
  await visit(root, "")
  const files = await mapConcurrent(
    pendingFiles,
    HASH_CONCURRENCY,
    async (file): Promise<LocalSyncFile> => ({
      ...file,
      sha256: await hashLocalFile(file.absolutePath),
    })
  )
  files.sort(comparePath)
  directories.sort(pathDepthOrder)
  excluded.sort((left, right) => left.localeCompare(right))
  return { directories, excluded, files, root }
}

/**
 * Walks the remote tree, skipping the same paths the local walk skips.
 *
 * An excluded directory is not descended into, which is what keeps a deploy
 * proportional to the files it manages rather than to the whole instance: a
 * game server's world and logs dwarf its configuration, are never uploaded,
 * and would otherwise be stat-ed in full on every run and counted against
 * MAX_SYNC_ENTRIES. Note that pruning follows the pattern, so `world` prunes
 * the directory while `world/**` still descends to skip each child - the same
 * distinction the local walk makes.
 */
async function readRemoteInventory(
  transport: FileSyncTransport,
  stagingBase: string,
  patterns: ReadonlyArray<string>
) {
  const entries = new Map<string, RemoteSyncEntry>()
  const excludes = patterns.map(compileExcludePattern)
  const listings = limit(REMOTE_CONCURRENCY)
  const visit = async (directory: string): Promise<void> => {
    const children = [
      ...(await listings(() => transport.list(directory))),
    ].sort((left, right) => left.name.localeCompare(right.name))
    const directories: Array<string> = []
    for (const child of children) {
      validateRemoteName(child.name)
      const path = directory ? `${directory}/${child.name}` : child.name
      if (path === stagingBase) continue
      if (matchesAnyExclude(path, excludes)) continue
      if (entries.size >= MAX_SYNC_ENTRIES) {
        throw new Error(`Remote server exceeds ${MAX_SYNC_ENTRIES} entries.`)
      }
      entries.set(path, child)
      if (child.kind === "directory") directories.push(path)
    }
    // Siblings are walked together; the semaphore, not the recursion, is what
    // bounds how many listings are in flight, so depth cannot multiply it.
    await Promise.all(directories.map(visit))
  }
  await visit("")
  return { entries }
}

/**
 * Runs at most `concurrency` operations at once, across every caller that
 * shares the returned function.
 */
function limit(concurrency: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async <TResult>(run: () => Promise<TResult>): Promise<TResult> => {
    if (active >= concurrency) {
      await new Promise<void>((release) => waiting.push(release))
    }
    active += 1
    try {
      return await run()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

async function readManagedManifest(path: string) {
  const absolutePath = resolve(path)
  const source = await readFile(absolutePath, "utf8")
  const manifest = fileSyncManifestSchema.parse(JSON.parse(source) as unknown)
  if (new Set(manifest.managed).size !== manifest.managed.length) {
    throw new Error("The managed file manifest contains duplicate paths.")
  }
  return { ...manifest, path: absolutePath }
}

async function planManagedDeletions(input: {
  excludes: ReadonlyArray<string>
  localFiles: ReadonlyArray<LocalSyncFile>
  manifest: Awaited<ReturnType<typeof readManagedManifest>> | null
  maxDelete: number
  remote: ReadonlyMap<string, RemoteSyncEntry>
  transport: FileSyncTransport
}): Promise<FileSyncPlan["deletions"]> {
  if (!input.manifest) {
    throw new Error("--delete-managed requires --manifest.")
  }
  const local = new Set(input.localFiles.map((file) => file.path))
  const excludes = input.excludes.map(compileExcludePattern)
  const worldRoots = new Set(
    [...input.remote]
      .filter(
        ([path, entry]) =>
          entry.kind === "file" &&
          (path === "level.dat" || path.endsWith("/level.dat"))
      )
      .map(([path]) => path.split("/").slice(0, -1).join("/"))
      .filter(Boolean)
  )
  const candidates: Array<{ path: string; size: number }> = []
  for (const path of input.manifest.managed) {
    if (local.has(path) || matchesAnyExclude(path, excludes)) continue
    const remote = input.remote.get(path)
    if (!remote) continue
    if (remote.kind !== "file") {
      throw new Error(
        `Managed deletion only supports regular files; ${path} is ${remote.kind}.`
      )
    }
    if (isProtectedDeletion(path, worldRoots)) {
      throw new Error(`Managed deletion cannot remove protected path ${path}.`)
    }
    candidates.push({ path, size: remote.size })
  }
  candidates.sort(comparePath)
  if (candidates.length > input.maxDelete) {
    throw new Error(
      `Managed deletion planned ${candidates.length} files, exceeding --max-delete ${input.maxDelete}.`
    )
  }
  return mapConcurrent(candidates, REMOTE_CONCURRENCY, async (file) => ({
    ...file,
    sha256: await input.transport.hash(file.path),
  }))
}

function isProtectedDeletion(
  path: string,
  worldRoots: ReadonlySet<string>
): boolean {
  const root = path.split("/")[0]?.toLowerCase() ?? ""
  if (PROTECTED_DELETE_ROOTS.has(root)) return true
  return [...worldRoots].some(
    (world) => path === world || path.startsWith(`${world}/`)
  )
}

function compileExcludePattern(pattern: string): RegExp {
  const normalized = pattern
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/^\/+|\/+$/gu, "")
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Invalid exclude pattern: ${pattern}`)
  }
  let source = ""
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] as string
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          source += "(?:.*/)?"
          index += 2
        } else {
          source += ".*"
          index += 1
        }
      } else source += "[^/]*"
    } else if (character === "?") source += "[^/]"
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  }
  return normalized.includes("/")
    ? new RegExp(`^${source}(?:/.*)?$`, "u")
    : new RegExp(`(?:^|/)${source}(?:$|/)`, "u")
}

function matchesAnyExclude(path: string, patterns: ReadonlyArray<RegExp>) {
  return patterns.some((pattern) => pattern.test(path))
}

function validateRemoteName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error("Relay returned an unsafe remote filename.")
  }
}

function uploadEntry(
  file: LocalSyncFile,
  reason: FileSyncPlan["upload"][number]["reason"],
  remote: {
    expectedTarget: { sha256?: string; size?: number } | null
    remoteSha256?: string
    remoteSize?: number
  }
): FileSyncPlan["upload"][number] {
  return {
    expectedTarget: remote.expectedTarget,
    path: file.path,
    reason,
    ...(remote.remoteSha256 === undefined
      ? {}
      : { remoteSha256: remote.remoteSha256 }),
    ...(remote.remoteSize === undefined
      ? {}
      : { remoteSize: remote.remoteSize }),
    sha256: file.sha256,
    size: file.size,
  }
}

function fileSyncOutput(
  server: string,
  plan: FileSyncPlan,
  result: AppliedFileSyncResult | null
): FileSyncOutput {
  return {
    mode: result ? "sync" : "plan",
    plan,
    result: result
      ? { ...result, status: "succeeded" }
      : {
          activated: [],
          bytesTransferred: 0,
          createdDirectories: [],
          deleted: [],
          stagingPath: plan.stagingPath,
          status: "planned",
          uploaded: [],
          verifiedFiles: 0,
        },
    server,
    type: "files.sync",
    version: 2,
  }
}

function deploymentStagingPath(
  stagingBase: string | undefined,
  deploymentId: string
): string {
  const base = normalizeRemotePath(stagingBase ?? DEFAULT_STAGING_BASE)
  return `${base}/${deploymentId}`
}

function normalizeRemotePath(path: string): string {
  const normalized = path.trim().replace(/\/+$/u, "")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw syncPlanningError(`Invalid remote staging path: ${path}`)
  }
  return normalized
}

function atomicStagingDirectories(plan: FileSyncPlan): Array<string> {
  if (!plan.stagingPath) return []
  const directories = new Set<string>([`${plan.stagingPath}/files`])
  for (const file of plan.upload) {
    const segments = file.path.split("/")
    segments.pop()
    let current = `${plan.stagingPath}/files`
    for (const segment of segments) {
      current = `${current}/${segment}`
      directories.add(current)
    }
  }
  return [...directories].sort(pathDepthOrder)
}

function resolveLocalPlanPath(root: string, path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw syncPlanningError(`Invalid sync plan path: ${path}`)
  }
  const candidate = resolve(root, ...path.split("/"))
  const relation = relative(root, candidate)
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    throw syncPlanningError(
      `Sync plan path escapes the local directory: ${path}`
    )
  }
  return candidate
}

function planningOperation<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof CliCommandError
        ? cause
        : commandError({
            cause,
            code: "sync_planning_failed",
            exitCode: 10,
            message: "Could not create the file sync plan.",
          }),
  })
}

function transferOperation<TResult>(
  run: () => Promise<TResult>,
  message: string
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      commandError({
        cause,
        code: "sync_transfer_failed",
        exitCode: 11,
        message,
        retryable: true,
      }),
  })
}

function verificationOperation<TResult>(
  run: () => Promise<TResult>,
  message: string
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      commandError({
        cause,
        code: "sync_verification_failed",
        exitCode: 12,
        message,
        retryable: true,
      }),
  })
}

function controllerOperation<TResult>(
  operation: Effect.Effect<TResult, CliCommandError>,
  message: string
) {
  return operation.pipe(
    Effect.mapError((cause) =>
      cause.exitCode === 3 || cause.exitCode === 4
        ? cause
        : commandError({
            cause,
            code: "sync_activation_failed",
            exitCode: 13,
            message,
            retryable: cause.retryable,
          })
    )
  )
}

function syncPlanningError(message: string) {
  return commandError({
    code: "sync_planning_failed",
    exitCode: 10,
    message,
  })
}

function syncVerificationError(message: string) {
  return commandError({
    code: "sync_verification_failed",
    exitCode: 12,
    message,
    retryable: true,
  })
}

function syncActivationError(message: string) {
  return commandError({
    code: "sync_activation_failed",
    exitCode: 13,
    message,
    retryable: true,
  })
}

function remoteEntry(
  entry: Pick<FileEntryWithStats, "attrs" | "filename">
): RemoteSyncEntry {
  return {
    kind: entry.attrs.isSymbolicLink()
      ? "symlink"
      : entry.attrs.isDirectory()
        ? "directory"
        : entry.attrs.isFile()
          ? "file"
          : "unsupported",
    name: entry.filename,
    size: entry.attrs.size,
  }
}

function sftpList(sftp: SFTPWrapper, path: string) {
  return sftpValue<Array<FileEntryWithStats>>((done) =>
    sftp.readdir(path, done)
  )
}

function sftpCallback(run: (done: (cause?: Error | null) => void) => void) {
  return new Promise<void>((resolvePromise, reject) => {
    const started = Result.try(() =>
      run((cause) => (cause ? reject(cause) : resolvePromise()))
    )
    if (Result.isFailure(started)) reject(started.failure)
  })
}

function sftpValue<TResult>(
  run: (done: (cause: Error | undefined, value: TResult) => void) => void
) {
  return new Promise<TResult>((resolvePromise, reject) => {
    const started = Result.try(() =>
      run((cause, value) => (cause ? reject(cause) : resolvePromise(value)))
    )
    if (Result.isFailure(started)) reject(started.failure)
  })
}

function hashSftpFile(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const digest = createHash("sha256")
    const stream = sftp.createReadStream(path)
    stream.on("data", (chunk: Buffer | string) => digest.update(chunk))
    stream.once("error", reject)
    stream.once("end", () => resolvePromise(digest.digest("hex")))
  })
}

function hashLocalFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const digest = createHash("sha256")
    const stream = createReadStream(path)
    stream.on("data", (chunk) => digest.update(chunk))
    stream.once("error", reject)
    stream.once("end", () => resolvePromise(digest.digest("hex")))
  })
}

async function mapConcurrent<TValue, TResult>(
  values: ReadonlyArray<TValue>,
  concurrency: number,
  map: (value: TValue, index: number) => Promise<TResult>
): Promise<Array<TResult>> {
  const results = new Array<TResult>(values.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= values.length) return
      results[index] = await map(values[index] as TValue, index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  )
  return results
}

function pathDepthOrder(left: string, right: string) {
  const depth = left.split("/").length - right.split("/").length
  return depth || left.localeCompare(right)
}

function comparePath(left: { path: string }, right: { path: string }): number {
  return left.path.localeCompare(right.path)
}
