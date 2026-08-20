import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve } from "node:path"

import { Effect } from "effect"
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2"

import { CliCommandError, commandError } from "./errors.js"
import { formatBytes, writeLine, writeTable } from "./output.js"
import { resolveRemotePath } from "./sftp.js"

const MAX_SYNC_ENTRIES = 100_000
const HASH_CONCURRENCY = 4
const TRANSFER_CONCURRENCY = 4

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

interface LocalSyncFile {
  absolutePath: string
  path: string
  sha256: string
  size: number
}

export interface FileSyncPlan {
  createDirectories: Array<string>
  excluded: Array<string>
  excludes: Array<string>
  localDirectory: string
  summary: {
    createDirectories: number
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
    sha256: string
    size: number
  }>
}

export interface FileSyncOutput {
  mode: "plan" | "sync"
  plan: FileSyncPlan
  result: {
    bytesTransferred: number
    createdDirectories: Array<string>
    status: "planned" | "succeeded"
    uploaded: Array<{ path: string; sha256: string; size: number }>
    verifiedFiles: number
  }
  server: string
  type: "files.sync"
  version: 1
}

interface AppliedFileSyncResult {
  bytesTransferred: number
  createdDirectories: Array<string>
  uploaded: Array<{ path: string; sha256: string; size: number }>
  verifiedFiles: number
}

export const runFileSyncEffect = Effect.fn("cli.files.sync")(function* (input: {
  excludes: ReadonlyArray<string>
  localDirectory: string
  planOnly: boolean
  server: string
  transport: FileSyncTransport
}) {
  const plan = yield* buildFileSyncPlanEffect(input)
  if (input.planOnly) return fileSyncOutput(input.server, plan, null)

  const result = yield* applyFileSyncPlanEffect(plan, input.transport)
  return fileSyncOutput(input.server, plan, result)
})

export const buildFileSyncPlanEffect = Effect.fn("cli.files.sync.plan")(
  function* (input: {
    excludes: ReadonlyArray<string>
    localDirectory: string
    transport: FileSyncTransport
  }) {
    const inventory = yield* planningOperation(() =>
      readLocalInventory(input.localDirectory, input.excludes)
    )
    const remote = yield* planningOperation(() =>
      readRemoteInventory(input.transport)
    )

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
        upload.push(uploadEntry(file, "missing"))
        continue
      }
      if (remoteEntry.kind !== "file") {
        return yield* syncPlanningError(
          `Remote path ${file.path} is ${remoteEntry.kind}; refusing to replace it.`
        )
      }
      if (remoteEntry.size !== file.size) {
        upload.push(
          uploadEntry(file, "size_changed", { remoteSize: remoteEntry.size })
        )
        continue
      }
      sameSize.push({ file, remote: remoteEntry })
    }

    const compared = yield* planningOperation(() =>
      mapConcurrent(sameSize, HASH_CONCURRENCY, async ({ file, remote }) => {
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
            remoteSha256,
            remoteSize: remote.size,
          })
        )
      }
    }

    createDirectories.sort(pathDepthOrder)
    unchanged.sort(comparePath)
    upload.sort(comparePath)
    const localBytes = inventory.files.reduce(
      (total, file) => total + file.size,
      0
    )
    const uploadBytes = upload.reduce((total, file) => total + file.size, 0)
    return {
      createDirectories,
      excluded: inventory.excluded,
      excludes: [...input.excludes],
      localDirectory: inventory.root,
      summary: {
        createDirectories: createDirectories.length,
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
      bytesTransferred: uploaded.reduce((total, file) => total + file.size, 0),
      createdDirectories: [...plan.createDirectories],
      uploaded,
      verifiedFiles: uploaded.length,
    }
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
  if (output.result.status === "planned") {
    writeLine("Plan only; no remote files changed.")
  } else {
    writeLine(
      `Uploaded and verified ${output.result.verifiedFiles} files (${formatBytes(output.result.bytesTransferred)}).`
    )
  }
}

async function readLocalInventory(
  localDirectory: string,
  patterns: ReadonlyArray<string>
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

async function readRemoteInventory(transport: FileSyncTransport) {
  const entries = new Map<string, RemoteSyncEntry>()
  const visit = async (directory: string): Promise<void> => {
    const children = [...(await transport.list(directory))].sort(
      (left, right) => left.name.localeCompare(right.name)
    )
    for (const child of children) {
      validateRemoteName(child.name)
      const path = directory ? `${directory}/${child.name}` : child.name
      if (entries.size >= MAX_SYNC_ENTRIES) {
        throw new Error(`Remote server exceeds ${MAX_SYNC_ENTRIES} entries.`)
      }
      entries.set(path, child)
      if (child.kind === "directory") await visit(path)
    }
  }
  await visit("")
  return { entries }
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
  remote: { remoteSha256?: string; remoteSize?: number } = {}
): FileSyncPlan["upload"][number] {
  return {
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
          bytesTransferred: 0,
          createdDirectories: [],
          status: "planned",
          uploaded: [],
          verifiedFiles: 0,
        },
    server,
    type: "files.sync",
    version: 1,
  }
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
    try {
      run((cause) => (cause ? reject(cause) : resolvePromise()))
    } catch (cause) {
      reject(cause)
    }
  })
}

function sftpValue<TResult>(
  run: (done: (cause: Error | undefined, value: TResult) => void) => void
) {
  return new Promise<TResult>((resolvePromise, reject) => {
    try {
      run((cause, value) => (cause ? reject(cause) : resolvePromise(value)))
    } catch (cause) {
      reject(cause)
    }
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
