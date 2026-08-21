import { CronExpressionParser } from "cron-parser"
import { Result } from "effect"
import { z } from "zod"

import {
  backupLocalDestinationSchema,
  backupModeSchema,
  backupResticDestinationSchema,
} from "./backups.js"

export const scheduleActionTypeSchema = z.enum([
  "console_command",
  "backup",
  "power",
])

export type ScheduleActionType = z.infer<typeof scheduleActionTypeSchema>

const scheduleActionIdSchema = z.uuid()

export const scheduleConsoleCommandActionSchema = z
  .object({
    command: z.string().trim().min(1).max(4_096),
    id: scheduleActionIdSchema,
    type: z.literal("console_command"),
  })
  .strict()

export const scheduleBackupActionSchema = z
  .object({
    destination: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("local") }).strict(),
        z
          .object({
            kind: z.literal("storage"),
            storageId: z.uuid(),
          })
          .strict(),
      ])
      .default({ kind: "local" }),
    id: scheduleActionIdSchema,
    mode: backupModeSchema.default("full"),
    name: z.string().trim().min(1).max(120).default("Scheduled backup"),
    type: z.literal("backup"),
  })
  .strict()

export const schedulePowerActionSchema = z
  .object({
    action: z.enum(["start", "stop", "restart", "kill"]),
    id: scheduleActionIdSchema,
    type: z.literal("power"),
  })
  .strict()

export const scheduleActionSchema = z.discriminatedUnion("type", [
  scheduleConsoleCommandActionSchema,
  scheduleBackupActionSchema,
  schedulePowerActionSchema,
])

export type ScheduleAction = z.infer<typeof scheduleActionSchema>

export const scheduleTargetSchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: z.enum(["instance", "database", "relay"]),
    name: z.string().trim().min(1).max(120),
    relayId: z.string().min(1).max(120),
  })
  .strict()

export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>

export const scheduleCronAliases = {
  daily: "0 0 * * *",
  hourly: "0 * * * *",
  monthly: "0 0 1 * *",
  weekly: "0 0 * * 0",
} as const

export type ScheduleCronAlias = keyof typeof scheduleCronAliases

export function normalizeScheduleCron(value: string): string {
  const normalized = value.trim().toLowerCase()
  return scheduleCronAliases[normalized as ScheduleCronAlias] ?? value.trim()
}

export function validateScheduleTimezone(value: string): boolean {
  return Result.isSuccess(
    Result.try(() =>
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format()
    )
  )
}

export function validateScheduleCron(value: string, timezone: string): boolean {
  if (!validateScheduleTimezone(timezone)) return false
  return Result.isSuccess(
    Result.try(() => {
      const normalized = normalizeScheduleCron(value)
      if (normalized.split(/\s+/u).length !== 5) {
        throw new Error("Cron expression must have five fields")
      }
      CronExpressionParser.parse(normalized, {
        currentDate: new Date(),
        tz: timezone,
      })
    })
  )
}

export function nextScheduleOccurrence(
  expression: string,
  timezone: string,
  after: Date | number | string = new Date()
): Date {
  return CronExpressionParser.parse(normalizeScheduleCron(expression), {
    currentDate: after,
    tz: timezone,
  })
    .next()
    .toDate()
}

export const scheduleInputSchema = z.object({
  actions: z.array(scheduleActionSchema).min(1).max(32),
  cron: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  name: z.string().trim().min(1).max(120),
  targets: z.array(scheduleTargetSchema).min(1).max(2_000),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(validateScheduleTimezone, "Timezone is invalid"),
})

export const scheduleDefinitionSchema = scheduleInputSchema
  .safeExtend({
    id: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict()
  .superRefine((schedule, context) => {
    if (!validateScheduleCron(schedule.cron, schedule.timezone)) {
      context.addIssue({
        code: "custom",
        message: "Cron expression is invalid",
        path: ["cron"],
      })
    }
    const actionIds = new Set(schedule.actions.map((action) => action.id))
    if (actionIds.size !== schedule.actions.length) {
      context.addIssue({
        code: "custom",
        message: "Action IDs must be unique",
        path: ["actions"],
      })
    }
    const targetIds = new Set(
      schedule.targets.map(
        (target) => `${target.relayId}:${target.kind}:${target.id}`
      )
    )
    if (targetIds.size !== schedule.targets.length) {
      context.addIssue({
        code: "custom",
        message: "Targets must be unique",
        path: ["targets"],
      })
    }
  })

export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>

const relayScheduleBackupExecutionSchema = z
  .object({
    destination: z.discriminatedUnion("kind", [
      backupLocalDestinationSchema,
      backupResticDestinationSchema,
    ]),
    mode: backupModeSchema,
    targetId: z.string().min(1).max(120),
    targetKind: z.enum(["instance", "database", "relay"]),
  })
  .strict()

export const relayScheduleBackupActionSchema = scheduleBackupActionSchema
  .safeExtend({
    executions: z
      .array(relayScheduleBackupExecutionSchema)
      .max(2_000)
      .default([]),
  })
  .strict()

export const relayScheduleActionSchema = z.discriminatedUnion("type", [
  scheduleConsoleCommandActionSchema,
  relayScheduleBackupActionSchema,
  schedulePowerActionSchema,
])

export type RelayScheduleAction = z.infer<typeof relayScheduleActionSchema>

export const relayScheduleProjectionSchema = scheduleDefinitionSchema
  .safeExtend({
    actions: z.array(relayScheduleActionSchema).min(1).max(32),
  })
  .strict()

export type RelayScheduleProjection = z.infer<
  typeof relayScheduleProjectionSchema
>

export const scheduleAttemptStatusSchema = z.enum([
  "succeeded",
  "failed",
  "skipped_unsupported",
  "skipped_missing",
  "skipped_policy",
  "interrupted",
  "not_run",
])

export const scheduleTargetRunStatusSchema = z.enum([
  "succeeded",
  "noop",
  "failed",
  "interrupted",
  "skipped_overlap",
])

export const scheduleRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "partial",
  "failed",
  "noop",
  "interrupted",
  "missed",
])

export const scheduleActionAttemptSchema = z
  .object({
    actionId: z.uuid(),
    actionType: scheduleActionTypeSchema,
    error: z.string().max(2_000).nullable(),
    finishedAt: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    startedAt: z.number().int().nonnegative(),
    status: scheduleAttemptStatusSchema,
  })
  .strict()

export const scheduleTargetRunSchema = z
  .object({
    attempts: z.array(scheduleActionAttemptSchema).max(32),
    error: z.string().max(2_000).nullable(),
    finishedAt: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    startedAt: z.number().int().nonnegative(),
    status: scheduleTargetRunStatusSchema,
    target: scheduleTargetSchema,
  })
  .strict()

export const scheduleRunSchema = z
  .object({
    finishedAt: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    scheduleId: z.uuid(),
    scheduledAt: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative(),
    status: scheduleRunStatusSchema,
    targetRuns: z.array(scheduleTargetRunSchema).max(2_000),
  })
  .strict()

export type ScheduleRun = z.infer<typeof scheduleRunSchema>

export const relayScheduleDeploymentSchema = z
  .object({
    acknowledgedRevision: z.number().int().positive(),
    nextRunAt: z.number().int().nonnegative().nullable(),
    scheduleId: z.uuid(),
  })
  .strict()

export type RelayScheduleDeployment = z.infer<
  typeof relayScheduleDeploymentSchema
>

export const relayScheduleOverviewSchema = z
  .object({
    deployments: z.array(relayScheduleDeploymentSchema),
    runs: z.array(scheduleRunSchema),
  })
  .strict()

export function scheduleStableId(...parts: ReadonlyArray<string | number>) {
  const value = parts.map(String).join("\u001f")
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => {
      let hash = seed >>> 0
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, "0")
    })
    .join("")
}

export function scheduleDeterministicUuid(
  ...parts: ReadonlyArray<string | number>
) {
  const hash = scheduleStableId(...parts).split("")
  hash[12] = "5"
  hash[16] = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16)
  const value = hash.join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function scheduleActionSupportsTarget(
  action: {
    action?: "kill" | "restart" | "start" | "stop"
    mode?: "full" | "incremental"
    type: ScheduleActionType
  },
  target: Pick<ScheduleTarget, "kind">
): boolean {
  if (action.type === "console_command") return target.kind === "instance"
  if (action.type === "power") {
    return (
      target.kind !== "relay" &&
      !(target.kind === "database" && action.action === "kill")
    )
  }
  if (action.mode === "incremental") return target.kind === "instance"
  return true
}
