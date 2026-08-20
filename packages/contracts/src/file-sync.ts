import { z } from "zod"

export const fileSyncRelativePathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path
        .split("/")
        .every((segment) => segment && segment !== "." && segment !== ".."),
    "Path must be relative and use forward slashes"
  )

export const fileSyncDeploymentSchema = z
  .object({
    deploymentId: z.uuid(),
    stagingPath: fileSyncRelativePathSchema,
  })
  .strict()

export const fileSyncTargetExpectationSchema = z
  .object({
    sha256: z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) => value.sha256 === undefined || value.size !== undefined,
    "A target hash requires an expected size"
  )

export const fileSyncActivationFileSchema = z
  .object({
    expectedTarget: fileSyncTargetExpectationSchema.nullable(),
    path: fileSyncRelativePathSchema,
    sha256: z.string().regex(/^[a-f\d]{64}$/u),
    size: z.number().int().nonnegative(),
  })
  .strict()

export const fileSyncDeletionSchema = z
  .object({
    path: fileSyncRelativePathSchema,
    sha256: z.string().regex(/^[a-f\d]{64}$/u),
    size: z.number().int().nonnegative(),
  })
  .strict()

export const fileSyncManifestSchema = z
  .object({
    managed: z.array(fileSyncRelativePathSchema).max(100_000),
    version: z.literal(1),
  })
  .strict()

export const relayFileSyncPrepareSchema = fileSyncDeploymentSchema
  .extend({
    deleteManaged: z.boolean(),
    instanceId: z.string().regex(/^[a-f\d]{40}$/u),
  })
  .strict()

export const relayFileSyncActivateSchema = fileSyncDeploymentSchema
  .extend({
    deletions: z.array(fileSyncDeletionSchema).max(2_000),
    directories: z.array(fileSyncRelativePathSchema).max(2_000),
    files: z.array(fileSyncActivationFileSchema).max(2_000),
    instanceId: z.string().regex(/^[a-f\d]{40}$/u),
    maxDelete: z.number().int().min(0).max(100_000),
  })
  .strict()
  .refine(
    (value) =>
      value.files.length + value.deletions.length + value.directories.length <=
      2_000,
    "A deployment can affect at most 2000 paths"
  )
  .refine(
    (value) => value.deletions.length <= value.maxDelete,
    "Managed deletion count exceeds the requested maximum"
  )

export const relayFileSyncCleanupSchema = fileSyncDeploymentSchema
  .extend({ instanceId: z.string().regex(/^[a-f\d]{40}$/u) })
  .strict()

export const relayFileSyncPrepareResultSchema = fileSyncDeploymentSchema
  .extend({ prepared: z.literal(true) })
  .strict()

export const relayFileSyncActivationResultSchema = fileSyncDeploymentSchema
  .extend({
    activated: z.array(fileSyncRelativePathSchema),
    deleted: z.array(fileSyncRelativePathSchema),
  })
  .strict()

export const relayFileSyncCleanupResultSchema = fileSyncDeploymentSchema
  .extend({ cleaned: z.boolean() })
  .strict()

export type FileSyncActivationFile = z.infer<
  typeof fileSyncActivationFileSchema
>
export type FileSyncDeletion = z.infer<typeof fileSyncDeletionSchema>
export type FileSyncManifest = z.infer<typeof fileSyncManifestSchema>
export type RelayFileSyncActivate = z.infer<typeof relayFileSyncActivateSchema>
export type RelayFileSyncActivationResult = z.infer<
  typeof relayFileSyncActivationResultSchema
>
export type RelayFileSyncCleanup = z.infer<typeof relayFileSyncCleanupSchema>
export type RelayFileSyncPrepare = z.infer<typeof relayFileSyncPrepareSchema>
