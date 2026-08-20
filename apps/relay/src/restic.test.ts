import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterAll, assert, describe, it } from "@effect/vitest"

import {
  createResticDriver,
  isUnsupportedExcludePattern,
  parseResticJsonLine,
  progressFromResticStatus,
  summaryFromResticJson,
  translateExcludePatterns,
  validateStagingTree,
  resticSnapshotSelector,
  type ResticSpawn,
} from "./restic.js"

const testDirectory = mkdtempSync(join(tmpdir(), "kiln-restic-"))

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

describe("restic JSON parsing", () => {
  it("reads status and summary lines", () => {
    assert.deepStrictEqual(
      progressFromResticStatus(
        parseResticJsonLine(
          '{"message_type":"status","bytes_done":10,"total_bytes":40}'
        )
      ),
      { bytesCompleted: 10, bytesTotal: 40 }
    )
    assert.deepStrictEqual(
      summaryFromResticJson(
        parseResticJsonLine(
          '{"message_type":"summary","snapshot_id":"abc12345","total_bytes_processed":40}'
        )
      ),
      { snapshotId: "abc12345", totalBytesProcessed: 40 }
    )
    assert.isNull(parseResticJsonLine("not-json"))
    assert.isNull(progressFromResticStatus({ message_type: "verbose_status" }))
  })
})

describe("restic exclude translation", () => {
  it("translates the supported subset and warns on unsupported patterns", () => {
    const translated = translateExcludePatterns([
      "# comment",
      "",
      ".DS_Store",
      "logs/**",
      "*.pid",
      "!keep.txt",
      "cache[0-9]",
      "build/{tmp,out}",
    ])
    assert.deepStrictEqual(translated.excludes, [
      ".DS_Store",
      "**/.DS_Store",
      "logs/**",
      "*.pid",
      "**/*.pid",
    ])
    assert.include(translated.warnings[0] ?? "", "negation")
    assert.include(translated.warnings[1] ?? "", "cache[0-9]")
    assert.include(translated.warnings[2] ?? "", "build/{tmp,out}")
    assert.isTrue(isUnsupportedExcludePattern("!(foo)"))
    assert.isFalse(isUnsupportedExcludePattern("world/**"))
  })
})

describe("restic driver", () => {
  it("passes --no-cache instead of an empty RESTIC_CACHE_DIR", async () => {
    let args: Array<string> | undefined
    let env: NodeJS.ProcessEnv | undefined
    const spawn: ResticSpawn = (_command, received, options) => {
      args = [...received]
      env = options.env
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = () => true
      queueMicrotask(() => {
        stdout.end()
        stderr.end()
        child.emit("close", 0)
      })
      return child
    }
    const driver = createResticDriver({ spawn })
    await driver.catConfig({
      password: "secret",
      repository: join(testDirectory, "repo"),
      signal: new AbortController().signal,
    })
    assert.strictEqual(args?.[0], "--no-cache")
    assert.isUndefined(env?.RESTIC_CACHE_DIR)
  })

  it("kills restic when the command promise rejects while the process is running", async () => {
    let killed: string | undefined
    const spawn: ResticSpawn = () => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = (signal) => {
        killed = String(signal ?? "SIGTERM")
        queueMicrotask(() => {
          stdout.end()
          stderr.end()
          child.emit("close", 1)
        })
        return true
      }
      queueMicrotask(() => {
        stdout.write(
          '{"message_type":"status","bytes_done":10,"total_bytes":99}\n'
        )
      })
      return child
    }
    const driver = createResticDriver({ spawn })
    let thrown = false
    try {
      await driver.backup({
        cwd: testDirectory,
        excludes: [],
        onProgress: () => {
          throw new Error("too large")
        },
        password: "secret",
        path: "instance",
        repository: join(testDirectory, "repo"),
        signal: new AbortController().signal,
        tags: ["task:1"],
      })
    } catch {
      thrown = true
    }
    assert.isTrue(thrown)
    assert.strictEqual(killed, "SIGTERM")
  })
  it("reuses a snapshot tagged with the task id", async () => {
    const spawn = fakeResticSpawn([
      {
        match: (args) => args.includes("cat"),
        stdout: "{}",
      },
      {
        match: (args) => args.includes("--tag") && args.includes("task:task-1"),
        stdout: JSON.stringify([{ id: "abcdef12" }]),
      },
      {
        match: (args) => args.includes("stats"),
        stdout: JSON.stringify({ total_size: 2048 }),
      },
    ])
    const driver = createResticDriver({ spawn })
    const snapshots = await driver.snapshotsByTag({
      password: "secret",
      repository: join(testDirectory, "repo"),
      signal: new AbortController().signal,
      tag: "task:task-1",
    })
    assert.deepStrictEqual(snapshots, [{ id: "abcdef12" }])
    const stats = await driver.stats({
      password: "secret",
      repository: join(testDirectory, "repo"),
      signal: new AbortController().signal,
      snapshotId: "abcdef12",
    })
    assert.strictEqual(stats.totalSize, 2048)
  })

  it("treats a missing snapshot as a successful forget", async () => {
    const spawn = fakeResticSpawn([
      {
        exitCode: 1,
        match: (args) => args.includes("forget"),
        stderr: 'Fatal: no matching ID found for sequence "deadbeef"',
      },
    ])
    const driver = createResticDriver({ spawn })
    await driver.forget({
      password: "secret",
      repository: join(testDirectory, "repo"),
      signal: new AbortController().signal,
      snapshotId: "deadbeef",
    })
  })
})

describe("restic staging validation", () => {
  it("accepts a regular file tree without warnings", async () => {
    const valid = join(testDirectory, "valid-staging")
    await mkdir(join(valid, "world"), { recursive: true })
    await writeFile(join(valid, "world", "level.dat"), "ok")
    const checked = await validateStagingTree(valid, { diskBytes: 10_000 })
    assert.strictEqual(checked.entries, 2)
    assert.strictEqual(checked.logicalBytes, 2)
    assert.deepStrictEqual(checked.warnings, [])
  })

  it("drops symlinks with a warning instead of failing the restore", async () => {
    const staging = join(testDirectory, "symlink-staging")
    await mkdir(join(staging, "world"), { recursive: true })
    await writeFile(join(staging, "world", "level.dat"), "ok")
    await symlink("/etc/passwd", join(staging, "link"))
    const checked = await validateStagingTree(staging, { diskBytes: 10_000 })
    assert.strictEqual(checked.logicalBytes, 2)
    assert.strictEqual(checked.warnings.length, 1)
    assert.include(checked.warnings[0] ?? "", "link")
    assert.isFalse(existsSync(join(staging, "link")))
    assert.isTrue(existsSync(join(staging, "world", "level.dat")))
  })
})

describe("restic path layout", () => {
  it("selects the instance directory so restore and export files sit at the root", () => {
    assert.strictEqual(
      resticSnapshotSelector("abcdef12", "/data/instances/server-one"),
      "abcdef12:/data/instances/server-one"
    )
  })

  it("dumps the snapshot subfolder as a zip rooted at /", async () => {
    let dumpArgs: Array<string> | undefined
    const spawn: ResticSpawn = (_command, args) => {
      dumpArgs = [...args]
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = () => true
      queueMicrotask(() => {
        stdout.end()
        stderr.end()
        child.emit("close", 0)
      })
      return child
    }
    const driver = createResticDriver({ spawn })
    const destination = join(testDirectory, "export.zip")
    await driver.dumpZip({
      destination,
      password: "secret",
      repository: join(testDirectory, "repo"),
      selector: resticSnapshotSelector(
        "abcdef12",
        "/data/instances/server-one"
      ),
      signal: new AbortController().signal,
    })
    assert.deepStrictEqual(dumpArgs, [
      "--no-cache",
      "dump",
      "-a",
      "zip",
      "abcdef12:/data/instances/server-one",
      "/",
    ])
  })
})

function fakeResticSpawn(
  responses: Array<{
    exitCode?: number
    match: (args: ReadonlyArray<string>) => boolean
    stderr?: string
    stdout?: string
  }>
): ResticSpawn {
  return (_command, args, options) => {
    const response = responses.find((candidate) => candidate.match(args))
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ReturnType<ResticSpawn>
    child.stdout = stdout
    child.stderr = stderr
    child.stdin = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => {
      stdout.end(response?.stdout ?? "")
      stderr.end(response?.stderr ?? "")
      child.emit("close", response?.exitCode ?? 0)
    })
    void options
    return child
  }
}
