import { randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import { Effect, Result } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import {
  normalizeScheduleCron,
  relayScheduleOverviewSchema,
  scheduleActionSupportsTarget,
  scheduleActionSchema,
  scheduleDefinitionSchema,
  scheduleInputSchema,
  scheduleRunSchema,
  scheduleTargetSchema,
  type RelayScheduleProjection,
  type ScheduleAction,
  type ScheduleDefinition,
  type ScheduleRun,
  type ScheduleTarget,
} from "@workspace/contracts"

import { prepareResticRepositoryLocation } from "@/backups/destinations"
import { loadBackupStorageEffect } from "@/backups/destinations/s3"
import { ensureBackupRepositoryEffect } from "@/effect/backups"
import { runAppEffect } from "@/effect/runtime"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import {
  hasPlatformPermission,
  isPlatformAdmin,
  listUserGrants,
  type AccessGrant,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  hasScheduleTargetPermission,
  scheduleActionPermission,
  scheduleAuthorizationFailure,
} from "@/lib/schedule-permissions"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"
import { requireAuthenticatedUser } from "@/server/auth"

const scheduleWriteSchema = scheduleInputSchema

const scheduleUpdateSchema = scheduleWriteSchema.safeExtend({ id: z.uuid() })
const scheduleIdSchema = z.strictObject({ id: z.uuid() })

interface ScheduleRow extends RowDataPacket {
  created_at: Date
  created_by: string
  cron_expression: string
  enabled: number
  id: string
  name: string
  revision: number
  timezone: string
  updated_at: Date
}

interface ScheduleActionRow extends RowDataPacket {
  action_config: unknown
  action_type: ScheduleAction["type"]
  id: string
  position: number
  schedule_id: string
}

interface ScheduleTargetRow extends RowDataPacket {
  relay_id: string
  schedule_id: string
  target_id: string
  target_kind: ScheduleTarget["kind"]
  target_name: string
}

interface ScheduleDeploymentRow extends RowDataPacket {
  acknowledged_revision: number | null
  desired_revision: number
  last_error: string | null
  next_run_at: Date | null
  relay_id: string
  schedule_id: string
  status: "applied" | "error" | "pending"
}

interface ScheduleRunRow extends RowDataPacket {
  relay_id: string
  run_json: unknown
  schedule_id: string
}

interface ScheduleTombstoneRow extends RowDataPacket {
  desired_revision: number
  relay_id: string
  schedule_id: string
}

interface TargetDirectoryRow extends RowDataPacket {
  id: string
  kind: ScheduleTarget["kind"]
  name: string
  relay_id: string
}

export const getScheduleOptions = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireAuthenticatedUser()
    const [grants, targets, relays] = await Promise.all([
      isPlatformAdmin(user) ? Promise.resolve([]) : listUserGrants(user.id),
      loadTargetDirectory(),
      listPersistedRelays(),
    ])
    const relayNames = new Map(relays.map((relay) => [relay.id, relay.name]))
    return targets.flatMap((target) => {
      if (
        !hasScheduleTargetPermission({
          grants,
          permission: "schedule.read",
          target,
          user,
        })
      ) {
        return []
      }
      const permittedActions = (
        ["console_command", "backup", "power"] as const
      ).filter((type) => {
        const permission = scheduleActionPermission({ type }, target)
        return (
          permission === null ||
          hasScheduleTargetPermission({ grants, permission, target, user })
        )
      })
      return [
        {
          ...target,
          relayName: relayNames.get(target.relayId) ?? target.relayId,
          canCreate: hasScheduleTargetPermission({
            grants,
            permission: "schedule.create",
            target,
            user,
          }),
          canDelete: hasScheduleTargetPermission({
            grants,
            permission: "schedule.delete",
            target,
            user,
          }),
          canExecute: hasScheduleTargetPermission({
            grants,
            permission: "schedule.execute",
            target,
            user,
          }),
          canUpdate: hasScheduleTargetPermission({
            grants,
            permission: "schedule.update",
            target,
            user,
          }),
          permittedActions,
        },
      ]
    })
  }
)

export const getSchedules = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireAuthenticatedUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const schedules = await loadSchedules()
    const visible = schedules.filter(
      (schedule) =>
        scheduleAuthorizationFailure({
          actions: [],
          grants,
          schedulePermission: "schedule.read",
          targets: schedule.targets,
          user,
        }) === null
    )
    await reconcileScheduleState(visible, user.id)
    await reconcileScheduleTombstones(user.id)
    const refreshed = await loadSchedules()
    const visibleIds = new Set(visible.map((schedule) => schedule.id))
    return refreshed.filter((schedule) => visibleIds.has(schedule.id))
  }
)

export const createSchedule = createServerFn({ method: "POST" })
  .validator(scheduleWriteSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const definition = scheduleDefinitionSchema.parse({
      ...data,
      cron: normalizeScheduleCron(data.cron),
      id: randomUUID(),
      revision: 1,
      targets: await canonicalTargets(data.targets),
    })
    requireScheduleAuthorization({
      actions: definition.actions,
      grants,
      schedulePermission: "schedule.create",
      targets: definition.targets,
      user,
    })
    await requireScheduleBackupDestinations(definition.actions, user)
    await saveNewSchedule(definition, user.id)
    await deploySchedule(definition, user.id)
    return (await loadSchedules()).find(
      (schedule) => schedule.id === definition.id
    )
  })

export const updateSchedule = createServerFn({ method: "POST" })
  .validator(scheduleUpdateSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const existing = (await loadSchedules()).find(
      (schedule) => schedule.id === data.id
    )
    if (!existing) throw new Error("Schedule not found")

    // Editing is all-or-nothing. The user must still be authorized for every
    // stored action, even when the proposed change removes that action.
    requireScheduleAuthorization({
      actions: existing.actions,
      grants,
      schedulePermission: "schedule.update",
      targets: existing.targets,
      user,
    })
    await requireScheduleBackupDestinations(existing.actions, user)
    const definition = scheduleDefinitionSchema.parse({
      ...data,
      cron: normalizeScheduleCron(data.cron),
      revision: existing.revision + 1,
      targets: await canonicalTargets(data.targets),
    })
    requireScheduleAuthorization({
      actions: definition.actions,
      grants,
      schedulePermission: "schedule.update",
      targets: definition.targets,
      user,
    })
    await requireScheduleBackupDestinations(definition.actions, user)
    const previousRelayIds = new Set(
      existing.targets.map((target) => target.relayId)
    )
    await replaceSchedule(definition)
    await deploySchedule(definition, user.id)
    const nextRelayIds = new Set(
      definition.targets.map((target) => target.relayId)
    )
    await removeRelayProjections(
      definition.id,
      definition.revision,
      [...previousRelayIds].filter((relayId) => !nextRelayIds.has(relayId)),
      user.id
    )
    return (await loadSchedules()).find(
      (schedule) => schedule.id === definition.id
    )
  })

export const deleteSchedule = createServerFn({ method: "POST" })
  .validator(scheduleIdSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const schedule = (await loadSchedules()).find(
      (candidate) => candidate.id === data.id
    )
    if (!schedule) throw new Error("Schedule not found")
    requireScheduleAuthorization({
      actions: [],
      grants,
      schedulePermission: "schedule.delete",
      targets: schedule.targets,
      user,
    })
    const revision = schedule.revision + 1
    await databasePool.execute(
      `UPDATE ${databaseTable("schedule")}
          SET enabled = FALSE, revision = ?, deleted_at = CURRENT_TIMESTAMP(3)
        WHERE id = ? AND deleted_at IS NULL`,
      [revision, schedule.id]
    )
    await removeRelayProjections(
      schedule.id,
      revision,
      [...new Set(schedule.targets.map((target) => target.relayId))],
      user.id
    )
    return { deleted: true, id: schedule.id }
  })

export const runScheduleNow = createServerFn({ method: "POST" })
  .validator(scheduleIdSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const schedule = (await loadSchedules()).find(
      (candidate) => candidate.id === data.id
    )
    if (!schedule) throw new Error("Schedule not found")
    requireScheduleAuthorization({
      actions: schedule.actions,
      grants,
      schedulePermission: "schedule.execute",
      targets: schedule.targets,
      user,
    })

    const relays = new Map(
      (await listPersistedRelays()).map((relay) => [relay.id, relay])
    )
    const relayIds = [
      ...new Set(schedule.targets.map((target) => target.relayId)),
    ]
    const results = await Promise.all(
      relayIds.map(async (relayId) => {
        const relay = relays.get(relayId)
        if (!relay?.enabled) {
          return { error: "Relay is unavailable", relayId, started: false }
        }
        const started = await promiseResult(() =>
          Promise.resolve(
            relayRpc(
              relay,
              "schedule.run",
              { revision: schedule.revision, scheduleId: schedule.id },
              15_000,
              user.id
            )
          ).then((value) => scheduleRunSchema.parse(value))
        )
        return Result.isSuccess(started)
          ? { error: null, relayId, started: true }
          : {
              error: errorMessage(started.failure),
              relayId,
              started: false,
            }
      })
    )
    return {
      relays: results,
      started: results.filter((result) => result.started).length,
      total: results.length,
    }
  })

function requireScheduleAuthorization(input: {
  actions: ReadonlyArray<ScheduleAction>
  grants: ReadonlyArray<AccessGrant>
  schedulePermission:
    | "schedule.create"
    | "schedule.delete"
    | "schedule.execute"
    | "schedule.update"
  targets: ReadonlyArray<ScheduleTarget>
  user: AuthenticatedUser
}) {
  const failure = scheduleAuthorizationFailure(input)
  if (failure) throw new Error(failure)
}

async function loadTargetDirectory(): Promise<Array<ScheduleTarget>> {
  const [rows] = await databasePool.query<TargetDirectoryRow[]>(
    `SELECT relay.id AS id, 'relay' AS kind, relay.name,
            relay.id AS relay_id
       FROM ${databaseTable("relay")} relay
      WHERE relay.enabled = TRUE
      UNION ALL
     SELECT instance.instance_id AS id, 'instance' AS kind,
            COALESCE(instance.display_name, instance.instance_id) AS name,
            instance.relay_id
       FROM ${databaseTable("instance")} instance
       JOIN ${databaseTable("relay")} relay ON relay.id = instance.relay_id
      WHERE relay.enabled = TRUE
      UNION ALL
     SELECT managed.database_id AS id, 'database' AS kind, managed.name,
            managed.relay_id
       FROM ${databaseTable("database")} managed
       JOIN ${databaseTable("relay")} relay ON relay.id = managed.relay_id
      WHERE relay.enabled = TRUE
      ORDER BY relay_id, kind, name`
  )
  return rows.map((row) =>
    scheduleTargetSchema.parse({
      id: row.id,
      kind: row.kind,
      name: row.name,
      relayId: row.relay_id,
    })
  )
}

async function canonicalTargets(
  requested: ReadonlyArray<ScheduleTarget>
): Promise<Array<ScheduleTarget>> {
  const directory = await loadTargetDirectory()
  const targets = new Map(
    directory.map((target) => [targetKey(target), target])
  )
  return requested.map((target) => {
    const canonical = targets.get(targetKey(target))
    if (!canonical) throw new Error(`${target.name} is no longer available`)
    return canonical
  })
}

function targetKey(target: ScheduleTarget) {
  return `${target.relayId}:${target.kind}:${target.id}`
}

async function saveNewSchedule(
  schedule: ScheduleDefinition,
  createdBy: string
) {
  await withScheduleTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO ${databaseTable("schedule")}
         (id, name, cron_expression, timezone, enabled, revision, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        schedule.id,
        schedule.name,
        schedule.cron,
        schedule.timezone,
        schedule.enabled,
        schedule.revision,
        createdBy,
      ]
    )
    await insertScheduleParts(connection, schedule)
  })
}

async function replaceSchedule(schedule: ScheduleDefinition) {
  await withScheduleTransaction(async (connection) => {
    const [result] = await connection.execute(
      `UPDATE ${databaseTable("schedule")}
          SET name = ?, cron_expression = ?, timezone = ?, enabled = ?,
              revision = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [
        schedule.name,
        schedule.cron,
        schedule.timezone,
        schedule.enabled,
        schedule.revision,
        schedule.id,
      ]
    )
    if (!("affectedRows" in result) || result.affectedRows !== 1) {
      throw new Error("Schedule was changed by another request")
    }
    await connection.execute(
      `DELETE FROM ${databaseTable("schedule_action")} WHERE schedule_id = ?`,
      [schedule.id]
    )
    await connection.execute(
      `DELETE FROM ${databaseTable("schedule_target")} WHERE schedule_id = ?`,
      [schedule.id]
    )
    await insertScheduleParts(connection, schedule)
  })
}

async function withScheduleTransaction<TResult>(
  operation: (
    connection: Awaited<ReturnType<typeof databasePool.getConnection>>
  ) => Promise<TResult>
) {
  const connection = await databasePool.getConnection()
  const result = await promiseResult(async () => {
    await connection.beginTransaction()
    const value = await operation(connection)
    await connection.commit()
    return value
  })
  if (Result.isFailure(result)) {
    await ignorePromise(() => connection.rollback())
  }
  connection.release()
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

async function insertScheduleParts(
  connection: Awaited<ReturnType<typeof databasePool.getConnection>>,
  schedule: ScheduleDefinition
) {
  for (const [position, action] of schedule.actions.entries()) {
    await connection.execute(
      `INSERT INTO ${databaseTable("schedule_action")}
         (id, schedule_id, position, action_type, action_config)
       VALUES (?, ?, ?, ?, ?)`,
      [action.id, schedule.id, position, action.type, JSON.stringify(action)]
    )
  }
  for (const target of schedule.targets) {
    await connection.execute(
      `INSERT INTO ${databaseTable("schedule_target")}
         (schedule_id, relay_id, target_kind, target_id, target_name)
       VALUES (?, ?, ?, ?, ?)`,
      [schedule.id, target.relayId, target.kind, target.id, target.name]
    )
  }
}

async function loadSchedules() {
  const [scheduleRows, actionRows, targetRows, deploymentRows, runRows] =
    await Promise.all([
      databasePool.query<ScheduleRow[]>(
        `SELECT id, name, cron_expression, timezone, enabled, revision,
                created_by, created_at, updated_at
           FROM ${databaseTable("schedule")}
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC`
      ),
      databasePool.query<ScheduleActionRow[]>(
        `SELECT id, schedule_id, position, action_type, action_config
           FROM ${databaseTable("schedule_action")}
          ORDER BY schedule_id, position`
      ),
      databasePool.query<ScheduleTargetRow[]>(
        `SELECT schedule_id, relay_id, target_kind, target_id, target_name
           FROM ${databaseTable("schedule_target")}
          ORDER BY schedule_id, relay_id, target_kind, target_name`
      ),
      databasePool.query<ScheduleDeploymentRow[]>(
        `SELECT schedule_id, relay_id, desired_revision,
                acknowledged_revision, status, next_run_at, last_error
           FROM ${databaseTable("schedule_deployment")}`
      ),
      databasePool.query<ScheduleRunRow[]>(
        `SELECT schedule_id, relay_id, run_json
           FROM ${databaseTable("schedule_run")}
          ORDER BY scheduled_at DESC
          LIMIT 1000`
      ),
    ])
  const actionsBySchedule = groupRows(actionRows[0], (row) => row.schedule_id)
  const targetsBySchedule = groupRows(targetRows[0], (row) => row.schedule_id)
  const deploymentsBySchedule = groupRows(
    deploymentRows[0],
    (row) => row.schedule_id
  )
  const runsBySchedule = groupRows(runRows[0], (row) => row.schedule_id)
  return scheduleRows[0].map((row) => {
    const definition = scheduleDefinitionSchema.parse({
      actions: (actionsBySchedule.get(row.id) ?? []).map((action) =>
        scheduleActionSchema.parse(jsonValue(action.action_config))
      ),
      cron: row.cron_expression,
      enabled: Boolean(row.enabled),
      id: row.id,
      name: row.name,
      revision: row.revision,
      targets: (targetsBySchedule.get(row.id) ?? []).map((target) => ({
        id: target.target_id,
        kind: target.target_kind,
        name: target.target_name,
        relayId: target.relay_id,
      })),
      timezone: row.timezone,
    })
    return {
      ...definition,
      createdAt: row.created_at.toISOString(),
      createdBy: row.created_by,
      deployments: (deploymentsBySchedule.get(row.id) ?? []).map(
        (deployment) => ({
          acknowledgedRevision: deployment.acknowledged_revision,
          desiredRevision: deployment.desired_revision,
          lastError: deployment.last_error,
          nextRunAt: deployment.next_run_at?.toISOString() ?? null,
          relayId: deployment.relay_id,
          status: deployment.status,
        })
      ),
      runs: (runsBySchedule.get(row.id) ?? []).flatMap((run) => {
        const parsed = scheduleRunSchema.safeParse(jsonValue(run.run_json))
        return parsed.success ? [{ ...parsed.data, relayId: run.relay_id }] : []
      }),
      updatedAt: row.updated_at.toISOString(),
    }
  })
}

function groupRows<TRow>(
  rows: ReadonlyArray<TRow>,
  key: (row: TRow) => string
) {
  const grouped = new Map<string, Array<TRow>>()
  for (const row of rows) {
    const value = key(row)
    const entries = grouped.get(value) ?? []
    entries.push(row)
    grouped.set(value, entries)
  }
  return grouped
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value
}

async function deploySchedule(schedule: ScheduleDefinition, subject: string) {
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  const targetsByRelay = groupRows(schedule.targets, (target) => target.relayId)
  await Promise.all(
    [...targetsByRelay].map(async ([relayId, targets]) => {
      const relay = relays.get(relayId)
      await deployScheduleToRelay(schedule, targets, relay, subject)
    })
  )
}

async function deployScheduleToRelay(
  schedule: ScheduleDefinition,
  targets: ReadonlyArray<ScheduleTarget>,
  relay: Awaited<ReturnType<typeof listPersistedRelays>>[number] | undefined,
  subject: string
) {
  const relayId = targets[0]?.relayId
  if (!relayId) return
  await upsertDeployment(schedule.id, relayId, schedule.revision, "pending")
  if (!relay?.enabled) {
    await deploymentError(
      schedule.id,
      relayId,
      schedule.revision,
      "Relay is unavailable"
    )
    return
  }
  const deployed = await promiseResult(async () => {
    const projection: RelayScheduleProjection = {
      ...schedule,
      actions: await Promise.all(
        schedule.actions.map(async (action) => {
          if (action.type !== "backup") return action
          const executions = []
          for (const target of targets) {
            if (!scheduleActionSupportsTarget(action, target)) continue
            executions.push(
              (async () => ({
                destination:
                  action.mode === "full"
                    ? ({ kind: "local" } as const)
                    : await scheduledResticDestination(action, target),
                mode: action.mode,
                targetId: target.id,
                targetKind: target.kind,
              }))()
            )
          }
          return {
            ...action,
            executions: await Promise.all(executions),
          }
        })
      ),
      targets: [...targets],
    }
    const result = z
      .object({
        acknowledgedRevision: z.number().int().positive(),
        nextRunAt: z.number().int().nonnegative().nullable(),
        scheduleId: z.uuid(),
      })
      .parse(
        await relayRpc(relay, "schedule.apply", projection, 15_000, subject)
      )
    await databasePool.execute(
      `UPDATE ${databaseTable("schedule_deployment")}
          SET acknowledged_revision = ?, status = 'applied',
              next_run_at = FROM_UNIXTIME(? / 1000), last_error = NULL
        WHERE schedule_id = ? AND relay_id = ?`,
      [result.acknowledgedRevision, result.nextRunAt, schedule.id, relayId]
    )
  })
  if (Result.isFailure(deployed)) {
    await deploymentError(
      schedule.id,
      relayId,
      schedule.revision,
      errorMessage(deployed.failure)
    )
  }
}

async function scheduledResticDestination(
  action: Extract<ScheduleAction, { type: "backup" }>,
  target: ScheduleTarget
) {
  const storageId =
    action.destination.kind === "storage" ? action.destination.storageId : null
  const repository = await runAppEffect(
    "schedules.ensureBackupRepository",
    ensureBackupRepositoryEffect({
      relayId: target.relayId,
      storageId,
      targetId: target.id,
    })
  )
  const location = await runAppEffect(
    "schedules.prepareBackupRepository",
    Effect.suspend(() =>
      prepareResticRepositoryLocation({
        objectPrefix: repository.objectPrefix,
        requireEnabled: true,
        storageId: repository.storageId,
      })
    )
  )
  return {
    kind: "restic" as const,
    repository: location,
    repositoryPassword: repository.password,
  }
}

async function requireScheduleBackupDestinations(
  actions: ReadonlyArray<ScheduleAction>,
  user: AuthenticatedUser
) {
  const backupActions = actions.filter(
    (action): action is Extract<ScheduleAction, { type: "backup" }> =>
      action.type === "backup"
  )
  if (
    backupActions.some(
      (action) =>
        action.mode === "full" && action.destination.kind === "storage"
    )
  ) {
    throw new Error(
      "Full scheduled backups must use Relay-local storage so they can run while Hearth is offline"
    )
  }
  const storageIds = [
    ...new Set(
      backupActions.flatMap((action) =>
        action.destination.kind === "storage"
          ? [action.destination.storageId]
          : []
      )
    ),
  ]
  await Promise.all(
    storageIds.map(async (storageId) => {
      const storage = await runAppEffect(
        "schedules.loadBackupStorage",
        loadBackupStorageEffect(storageId)
      )
      if (
        !storage ||
        !storage.enabled ||
        storage.deleting ||
        (storage.ownerUserId !== null &&
          storage.ownerUserId !== user.id &&
          !hasPlatformPermission(user, "platform.backups.manage-storage"))
      ) {
        throw new Error("Backup destination is unavailable")
      }
    })
  )
}

async function removeRelayProjections(
  scheduleId: string,
  revision: number,
  relayIds: ReadonlyArray<string>,
  subject: string
) {
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  await Promise.all(
    relayIds.map(async (relayId) => {
      await upsertDeployment(scheduleId, relayId, revision, "pending")
      const relay = relays.get(relayId)
      if (!relay?.enabled) {
        await deploymentError(
          scheduleId,
          relayId,
          revision,
          "Relay is unavailable"
        )
        return
      }
      const removed = await promiseResult(async () => {
        await relayRpc(
          relay,
          "schedule.remove",
          { revision, scheduleId },
          15_000,
          subject
        )
        await databasePool.execute(
          `DELETE FROM ${databaseTable("schedule_deployment")}
            WHERE schedule_id = ? AND relay_id = ?`,
          [scheduleId, relayId]
        )
      })
      if (Result.isFailure(removed)) {
        await deploymentError(
          scheduleId,
          relayId,
          revision,
          errorMessage(removed.failure)
        )
      }
    })
  )
}

async function reconcileScheduleState(
  schedules: ReadonlyArray<ScheduleDefinition>,
  subject: string
) {
  const projectionsByRelay = new Map<
    string,
    Array<{ schedule: ScheduleDefinition; targets: Array<ScheduleTarget> }>
  >()
  for (const schedule of schedules) {
    for (const [relayId, targets] of groupRows(
      schedule.targets,
      (target) => target.relayId
    )) {
      const projections = projectionsByRelay.get(relayId) ?? []
      projections.push({ schedule, targets })
      projectionsByRelay.set(relayId, projections)
    }
  }
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  await Promise.all(
    [...projectionsByRelay].map(async ([relayId, projections]) => {
      const relay = relays.get(relayId)
      if (!relay?.enabled) return
      const reconciled = await promiseResult(async () => {
        const overview = relayScheduleOverviewSchema.parse(
          await relayRpc(
            relay,
            "schedule.overview",
            { scheduleIds: projections.map(({ schedule }) => schedule.id) },
            15_000
          )
        )
        await importRelayScheduleOverview(relayId, overview)
        const revisions = new Map(
          overview.deployments.map((deployment) => [
            deployment.scheduleId,
            deployment.acknowledgedRevision,
          ])
        )
        await Promise.all(
          projections.map(({ schedule, targets }) =>
            revisions.get(schedule.id) === schedule.revision
              ? Promise.resolve()
              : deployScheduleToRelay(schedule, targets, relay, subject)
          )
        )
      })
      if (Result.isFailure(reconciled)) {
        // The last acknowledged next-run and history remain available while a
        // Relay is disconnected. Disconnection is not recorded as a run fail.
        return
      }
    })
  )
}

async function reconcileScheduleTombstones(subject: string) {
  const [rows] = await databasePool.query<ScheduleTombstoneRow[]>(
    `SELECT deployment.schedule_id, deployment.relay_id,
            deployment.desired_revision
       FROM ${databaseTable("schedule_deployment")} deployment
       JOIN ${databaseTable("schedule")} schedule
         ON schedule.id = deployment.schedule_id
      WHERE schedule.deleted_at IS NOT NULL
         OR NOT EXISTS (
           SELECT 1
             FROM ${databaseTable("schedule_target")} target
            WHERE target.schedule_id = deployment.schedule_id
              AND target.relay_id = deployment.relay_id
         )`
  )
  await Promise.all(
    rows.map((row) =>
      removeRelayProjections(
        row.schedule_id,
        row.desired_revision,
        [row.relay_id],
        subject
      )
    )
  )
}

async function importRelayScheduleOverview(
  relayId: string,
  overview: z.infer<typeof relayScheduleOverviewSchema>
) {
  for (const deployment of overview.deployments) {
    await databasePool.execute(
      `UPDATE ${databaseTable("schedule_deployment")}
          SET acknowledged_revision = ?, status = 'applied',
              next_run_at = FROM_UNIXTIME(? / 1000), last_error = NULL
        WHERE schedule_id = ? AND relay_id = ?`,
      [
        deployment.acknowledgedRevision,
        deployment.nextRunAt,
        deployment.scheduleId,
        relayId,
      ]
    )
  }
  for (const run of overview.runs) await importScheduleRun(relayId, run)
}

async function importScheduleRun(relayId: string, run: ScheduleRun) {
  await databasePool.execute(
    `INSERT INTO ${databaseTable("schedule_run")}
       (id, schedule_id, relay_id, scheduled_at, status, run_json)
     VALUES (?, ?, ?, FROM_UNIXTIME(? / 1000), ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status),
       run_json = VALUES(run_json)`,
    [
      run.id,
      run.scheduleId,
      relayId,
      run.scheduledAt,
      run.status,
      JSON.stringify(run),
    ]
  )
}

async function upsertDeployment(
  scheduleId: string,
  relayId: string,
  revision: number,
  status: "pending"
) {
  await databasePool.execute(
    `INSERT INTO ${databaseTable("schedule_deployment")}
       (schedule_id, relay_id, desired_revision, status)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE desired_revision = VALUES(desired_revision),
       status = VALUES(status), last_error = NULL`,
    [scheduleId, relayId, revision, status]
  )
}

async function deploymentError(
  scheduleId: string,
  relayId: string,
  revision: number,
  error: string
) {
  await databasePool.execute(
    `INSERT INTO ${databaseTable("schedule_deployment")}
       (schedule_id, relay_id, desired_revision, status, last_error)
     VALUES (?, ?, ?, 'error', ?)
     ON DUPLICATE KEY UPDATE desired_revision = VALUES(desired_revision),
       status = 'error', last_error = VALUES(last_error)`,
    [scheduleId, relayId, revision, error.slice(0, 2_000)]
  )
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unknown Relay error"
}

function promiseResult<TResult>(run: () => Promise<TResult>) {
  return Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: run, catch: (cause) => cause }))
  )
}

async function ignorePromise(run: () => Promise<unknown>): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(Effect.ignore)
  )
}
