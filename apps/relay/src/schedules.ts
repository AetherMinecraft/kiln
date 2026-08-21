import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { Effect, Result } from "effect"
import { z } from "zod"

import {
  nextScheduleOccurrence,
  relayScheduleProjectionSchema,
  scheduleActionSupportsTarget,
  scheduleDeterministicUuid,
  scheduleRunSchema,
  scheduleStableId,
  type BackupTaskInput,
  type RelayBackupTask,
  type RelayScheduleDeployment,
  type RelayScheduleProjection,
  type ScheduleAction,
  type ScheduleActionType,
  type ScheduleRun,
  type ScheduleTarget,
} from "@workspace/contracts"

import { writeFileAtomic } from "./effect/atomic-file.js"

const persistedScheduleSchema = relayScheduleProjectionSchema.safeExtend({
  nextRunAt: z.number().int().nonnegative().nullable(),
})

const persistedStateSchema = z
  .object({
    lastHeartbeatAt: z.number().int().nonnegative(),
    runs: z.array(scheduleRunSchema).max(1_000),
    schedules: z.array(persistedScheduleSchema),
    tombstones: z.record(z.string(), z.number().int().positive()),
    version: z.literal(1),
  })
  .strict()

type PersistedSchedule = z.infer<typeof persistedScheduleSchema>
type PersistedState = z.infer<typeof persistedStateSchema>

const heartbeatPersistenceIntervalMs = 5_000
const maxRetainedRuns = 1_000

export interface ScheduleManagerOptions {
  readonly enqueueBackup: (input: BackupTaskInput) => Promise<RelayBackupTask>
  readonly findInstance: (instanceId: string) => Promise<object | null>
  readonly getBackup: (taskId: string) => Promise<RelayBackupTask | null>
  readonly listDatabaseIds: () => Promise<ReadonlySet<string>>
  readonly platformTargetId: string
  readonly relayId: string
  readonly runDatabasePower: (
    databaseId: string,
    action: "restart" | "start" | "stop"
  ) => Promise<void>
  readonly runInstancePower: (
    instanceId: string,
    action: "kill" | "restart" | "start" | "stop"
  ) => Promise<void>
  readonly sendConsoleCommand: (
    instanceId: string,
    command: string
  ) => Promise<void>
  readonly stateDirectory: string
}

export class ScheduleManager {
  readonly #activeTargets = new Set<string>()
  readonly #options: ScheduleManagerOptions
  readonly #statePath: string
  #lastHeartbeatPersistedAt = 0
  #state: PersistedState
  #tail = Promise.resolve()

  private constructor(options: ScheduleManagerOptions, state: PersistedState) {
    this.#options = options
    this.#state = state
    this.#statePath = resolve(options.stateDirectory, "schedules.json")
  }

  static async make(options: ScheduleManagerOptions) {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
    const path = resolve(options.stateDirectory, "schedules.json")
    const state = await readScheduleState(path)
    const manager = new ScheduleManager(options, state)
    await manager.#recoverAfterRestart()
    return manager
  }

  run() {
    return Effect.tryPromise(() => this.#tick()).pipe(
      Effect.andThen(Effect.sleep("1 second")),
      Effect.forever
    )
  }

  apply(projection: RelayScheduleProjection) {
    return this.#serialized(async () => {
      const input = relayScheduleProjectionSchema.parse(projection)
      const tombstoneRevision = this.#state.tombstones[input.id] ?? 0
      const current = this.#state.schedules.find(
        (schedule) => schedule.id === input.id
      )
      if (tombstoneRevision >= input.revision) {
        return deployment(input.id, tombstoneRevision, null)
      }
      if (current && current.revision > input.revision) {
        return deployment(current.id, current.revision, current.nextRunAt)
      }
      const nextRunAt = input.enabled
        ? nextScheduleOccurrence(
            input.cron,
            input.timezone,
            Date.now()
          ).getTime()
        : null
      const stored: PersistedSchedule = { ...input, nextRunAt }
      this.#state.schedules = [
        ...this.#state.schedules.filter((schedule) => schedule.id !== input.id),
        stored,
      ]
      delete this.#state.tombstones[input.id]
      await this.#persist()
      return deployment(input.id, input.revision, nextRunAt)
    })
  }

  remove(input: { revision: number; scheduleId: string }) {
    return this.#serialized(async () => {
      const scheduleId = z.uuid().parse(input.scheduleId)
      const revision = z.number().int().positive().parse(input.revision)
      const current = this.#state.schedules.find(
        (schedule) => schedule.id === scheduleId
      )
      const appliedRevision = Math.max(
        revision,
        current?.revision ?? 0,
        this.#state.tombstones[scheduleId] ?? 0
      )
      this.#state.schedules = this.#state.schedules.filter(
        (schedule) => schedule.id !== scheduleId
      )
      this.#state.tombstones[scheduleId] = appliedRevision
      await this.#persist()
      return deployment(scheduleId, appliedRevision, null)
    })
  }

  async runNow(input: { revision: number; scheduleId: string }) {
    const occurrence = await this.#serialized(async () => {
      const scheduleId = z.uuid().parse(input.scheduleId)
      const revision = z.number().int().positive().parse(input.revision)
      const schedule = this.#state.schedules.find(
        (candidate) => candidate.id === scheduleId
      )
      if (!schedule) throw new Error("Schedule is not deployed on this Relay")
      if (schedule.revision !== revision) {
        throw new Error("Schedule deployment is out of date")
      }
      const latestScheduledAt = this.#state.runs.reduce(
        (latest, run) =>
          run.scheduleId === scheduleId
            ? Math.max(latest, run.scheduledAt)
            : latest,
        0
      )
      const scheduledAt = Math.max(Date.now(), latestScheduledAt + 1)
      const { nextRunAt: _, ...definition } = schedule
      const run = scheduleRunSchema.parse({
        finishedAt: scheduledAt,
        id: scheduleStableId(schedule.id, scheduledAt, this.#options.relayId),
        revision: schedule.revision,
        scheduleId: schedule.id,
        scheduledAt,
        startedAt: scheduledAt,
        status: "interrupted",
        targetRuns: [],
      })
      this.#upsertRun(run)
      await this.#persist()
      return { definition, run, scheduledAt }
    })
    this.#launchOccurrence(occurrence.definition, occurrence.scheduledAt)
    return occurrence.run
  }

  overview(scheduleIds?: ReadonlyArray<string>) {
    const allowed = scheduleIds
      ? new Set(scheduleIds.map((id) => z.uuid().parse(id)))
      : null
    const deployments: Array<RelayScheduleDeployment> = this.#state.schedules
      .filter((schedule) => !allowed || allowed.has(schedule.id))
      .map((schedule) =>
        deployment(schedule.id, schedule.revision, schedule.nextRunAt)
      )
    const runs = this.#state.runs.filter(
      (run) => !allowed || allowed.has(run.scheduleId)
    )
    return { deployments, runs }
  }

  async #recoverAfterRestart() {
    const now = Date.now()
    for (const schedule of this.#state.schedules) {
      if (
        !schedule.enabled ||
        schedule.nextRunAt === null ||
        schedule.nextRunAt > now
      ) {
        continue
      }
      const run = scheduleRunSchema.parse({
        finishedAt: now,
        id: scheduleStableId(
          schedule.id,
          schedule.nextRunAt,
          this.#options.relayId
        ),
        revision: schedule.revision,
        scheduleId: schedule.id,
        scheduledAt: schedule.nextRunAt,
        startedAt: now,
        status: "missed",
        targetRuns: [],
      })
      this.#upsertRun(run)
      schedule.nextRunAt = nextScheduleOccurrence(
        schedule.cron,
        schedule.timezone,
        now
      ).getTime()
    }
    this.#state.lastHeartbeatAt = now
    await this.#persist()
  }

  async #tick() {
    const due = await this.#serialized(async () => {
      const now = Date.now()
      const claimed: Array<{
        definition: RelayScheduleProjection
        scheduledAt: number
      }> = []
      for (const schedule of this.#state.schedules) {
        if (
          !schedule.enabled ||
          schedule.nextRunAt === null ||
          schedule.nextRunAt > now
        ) {
          continue
        }
        const scheduledAt = schedule.nextRunAt
        const { nextRunAt: _, ...definition } = schedule
        claimed.push({ definition, scheduledAt })
        schedule.nextRunAt = nextScheduleOccurrence(
          schedule.cron,
          schedule.timezone,
          now
        ).getTime()
        const interrupted = scheduleRunSchema.parse({
          finishedAt: now,
          id: scheduleStableId(schedule.id, scheduledAt, this.#options.relayId),
          revision: schedule.revision,
          scheduleId: schedule.id,
          scheduledAt,
          startedAt: now,
          status: "interrupted",
          targetRuns: [],
        })
        this.#upsertRun(interrupted)
      }
      const persistHeartbeat =
        now - this.#lastHeartbeatPersistedAt >= heartbeatPersistenceIntervalMs
      this.#state.lastHeartbeatAt = now
      if (claimed.length > 0 || persistHeartbeat) {
        this.#lastHeartbeatPersistedAt = now
        await this.#persist()
      }
      return claimed
    })
    for (const occurrence of due) {
      this.#launchOccurrence(occurrence.definition, occurrence.scheduledAt)
    }
  }

  #launchOccurrence(definition: RelayScheduleProjection, scheduledAt: number) {
    Effect.runFork(
      Effect.tryPromise({
        try: () => this.#executeOccurrence(definition, scheduledAt),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            console.error(`Scheduled occurrence ${definition.id} failed`, cause)
          )
        )
      )
    )
  }

  async #executeOccurrence(
    schedule: RelayScheduleProjection,
    scheduledAt: number
  ) {
    const startedAt = Date.now()
    const targetRuns = await Promise.all(
      schedule.targets.map((target) =>
        this.#executeTarget(schedule, target, scheduledAt)
      )
    )
    const run = scheduleRunSchema.parse({
      finishedAt: Date.now(),
      id: scheduleStableId(schedule.id, scheduledAt, this.#options.relayId),
      revision: schedule.revision,
      scheduleId: schedule.id,
      scheduledAt,
      startedAt,
      status: aggregateRunStatus(targetRuns.map((target) => target.status)),
      targetRuns,
    })
    await this.#serialized(async () => {
      this.#upsertRun(run)
      await this.#persist()
    })
  }

  async #executeTarget(
    schedule: RelayScheduleProjection,
    target: ScheduleTarget,
    scheduledAt: number
  ) {
    const id = scheduleStableId(
      schedule.id,
      scheduledAt,
      target.kind,
      target.id
    )
    const startedAt = Date.now()
    const activeKey = `${target.kind}:${target.id}`
    if (this.#activeTargets.has(activeKey)) {
      return {
        attempts: [],
        error: null,
        finishedAt: Date.now(),
        id,
        startedAt,
        status: "skipped_overlap" as const,
        target,
      }
    }
    this.#activeTargets.add(activeKey)
    const executed = await promiseResult(async () => {
      if (!(await this.#targetExists(target))) {
        return {
          attempts: schedule.actions.map((action) =>
            attempt({
              action,
              error: "Target no longer exists",
              scheduledAt,
              scheduleId: schedule.id,
              startedAt,
              status: "skipped_missing",
              target,
            })
          ),
          error: "Target no longer exists",
          finishedAt: Date.now(),
          id,
          startedAt,
          status: "noop" as const,
          target,
        }
      }
      const attempts = []
      let failure: string | null = null
      for (const action of schedule.actions) {
        const actionStartedAt = Date.now()
        if (failure) {
          attempts.push(
            attempt({
              action,
              error: "A previous action failed",
              scheduledAt,
              scheduleId: schedule.id,
              startedAt: actionStartedAt,
              status: "not_run",
              target,
            })
          )
          continue
        }
        if (
          !scheduleActionSupportsTarget(action, target) ||
          (action.type === "power" &&
            action.action === "kill" &&
            target.kind === "database")
        ) {
          attempts.push(
            attempt({
              action,
              error: null,
              scheduledAt,
              scheduleId: schedule.id,
              startedAt: actionStartedAt,
              status: "skipped_unsupported",
              target,
            })
          )
          continue
        }
        const actionResult = await promiseResult(() =>
          this.#executeAction(schedule, action, target, scheduledAt)
        )
        if (Result.isSuccess(actionResult)) {
          attempts.push(
            attempt({
              action,
              error: null,
              scheduledAt,
              scheduleId: schedule.id,
              startedAt: actionStartedAt,
              status: "succeeded",
              target,
            })
          )
        } else {
          failure = errorMessage(actionResult.failure)
          attempts.push(
            attempt({
              action,
              error: failure,
              scheduledAt,
              scheduleId: schedule.id,
              startedAt: actionStartedAt,
              status: "failed",
              target,
            })
          )
        }
      }
      const succeeded = attempts.some((entry) => entry.status === "succeeded")
      return {
        attempts,
        error: failure,
        finishedAt: Date.now(),
        id,
        startedAt,
        status: failure
          ? ("failed" as const)
          : succeeded
            ? ("succeeded" as const)
            : ("noop" as const),
        target,
      }
    })
    this.#activeTargets.delete(activeKey)
    if (Result.isSuccess(executed)) return executed.success
    return {
      attempts: [],
      error: errorMessage(executed.failure),
      finishedAt: Date.now(),
      id,
      startedAt,
      status: "failed" as const,
      target,
    }
  }

  async #targetExists(target: ScheduleTarget) {
    if (target.kind === "relay") return target.id === this.#options.relayId
    if (target.kind === "instance") {
      return (await this.#options.findInstance(target.id)) !== null
    }
    return (await this.#options.listDatabaseIds()).has(target.id)
  }

  async #executeAction(
    schedule: RelayScheduleProjection,
    action: ScheduleAction,
    target: ScheduleTarget,
    scheduledAt: number
  ) {
    if (action.type === "console_command" && target.kind === "instance") {
      await this.#options.sendConsoleCommand(target.id, action.command)
      return
    }
    if (action.type === "power") {
      if (target.kind === "instance") {
        await this.#options.runInstancePower(target.id, action.action)
        return
      }
      if (target.kind === "database") {
        if (action.action === "kill") {
          throw new Error("Kill is not supported for databases")
        }
        await this.#options.runDatabasePower(target.id, action.action)
        return
      }
    }
    if (action.type === "backup") {
      const backupId = scheduleDeterministicUuid(
        "schedule-backup",
        schedule.id,
        scheduledAt,
        target.kind,
        target.id,
        action.id
      )
      const taskId = scheduleDeterministicUuid("task", backupId)
      const targetKind = target.kind === "relay" ? "platform" : target.kind
      const input: BackupTaskInput = {
        artifactKind:
          targetKind === "instance"
            ? "archive"
            : targetKind === "database"
              ? "database_dump"
              : "platform_bundle",
        backupId,
        destination: { kind: "local" },
        exclude: [],
        kind: "create",
        maxBytes: null,
        mode: "full",
        reason: "scheduled",
        target: {
          id:
            targetKind === "platform"
              ? this.#options.platformTargetId
              : target.id,
          kind: targetKind,
        },
        taskId,
      }
      const queued = await this.#options.enqueueBackup(input)
      await this.#waitForBackup(queued)
    }
  }

  async #waitForBackup(initial: RelayBackupTask) {
    let task: RelayBackupTask | null = initial
    while (task && (task.status === "queued" || task.status === "running")) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
      task = await this.#options.getBackup(initial.taskId)
    }
    if (!task) throw new Error("Scheduled backup disappeared from the queue")
    if (task.status !== "succeeded") {
      throw new Error(task.error ?? `Scheduled backup ${task.status}`)
    }
  }

  #upsertRun(run: ScheduleRun) {
    this.#state.runs = [
      run,
      ...this.#state.runs.filter((candidate) => candidate.id !== run.id),
    ].slice(0, maxRetainedRuns)
  }

  #serialized<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.#tail.then(operation)
    this.#tail = Effect.runPromise(
      Effect.tryPromise({ try: () => result, catch: (cause) => cause }).pipe(
        Effect.ignore
      )
    )
    return result
  }

  #persist() {
    return Effect.runPromise(
      writeFileAtomic(this.#statePath, JSON.stringify(this.#state), 0o600)
    )
  }
}

function deployment(
  scheduleId: string,
  acknowledgedRevision: number,
  nextRunAt: number | null
): RelayScheduleDeployment {
  return { acknowledgedRevision, nextRunAt, scheduleId }
}

function attempt(input: {
  action: Pick<ScheduleAction, "id" | "type">
  error: string | null
  scheduledAt: number
  scheduleId: string
  startedAt: number
  status:
    | "failed"
    | "not_run"
    | "skipped_missing"
    | "skipped_unsupported"
    | "succeeded"
  target: ScheduleTarget
}) {
  return {
    actionId: input.action.id,
    actionType: input.action.type as ScheduleActionType,
    error: input.error,
    finishedAt: Date.now(),
    id: scheduleStableId(
      input.scheduleId,
      input.scheduledAt,
      input.target.kind,
      input.target.id,
      input.action.id
    ),
    startedAt: input.startedAt,
    status: input.status,
  }
}

function aggregateRunStatus(
  statuses: ReadonlyArray<
    "failed" | "interrupted" | "noop" | "skipped_overlap" | "succeeded"
  >
) {
  const failed = statuses.filter(
    (status) => status === "failed" || status === "interrupted"
  ).length
  if (failed === statuses.length && statuses.length > 0)
    return "failed" as const
  if (failed > 0) return "partial" as const
  if (statuses.some((status) => status === "succeeded")) {
    return "succeeded" as const
  }
  return "noop" as const
}

async function readScheduleState(path: string): Promise<PersistedState> {
  const loaded = await promiseResult(async () =>
    persistedStateSchema.parse(JSON.parse(await readFile(path, "utf8")))
  )
  if (Result.isFailure(loaded)) {
    const cause = loaded.failure
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return {
        lastHeartbeatAt: Date.now(),
        runs: [],
        schedules: [],
        tombstones: {},
        version: 1,
      }
    }
    throw cause
  }
  return loaded.success
}

function promiseResult<TResult>(run: () => Promise<TResult>) {
  return Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: run, catch: (cause) => cause }))
  )
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unknown schedule error"
}
