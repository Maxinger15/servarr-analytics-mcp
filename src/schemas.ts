import * as z from "zod/v4";
import { APPS } from "./types.js";

export const appSchema = z.enum(APPS);
export const detailSchema = z.enum(["summary", "normal", "verbose", "raw"]).default("normal");

export const commonOptionsSchema = z.object({
  detail: detailSchema.optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(500).optional(),
  limit: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sampleRecords: z.number().int().min(0).max(50).optional(),
  fields: z.array(z.string().min(1)).optional(),
  groupBy: z.string().min(1).optional(),
  cursor: z.string().optional()
});

export const appOptionsSchema = commonOptionsSchema.extend({
  app: appSchema
});

export const optionalAppOptionsSchema = commonOptionsSchema.extend({
  app: appSchema.optional()
});

export const idSchema = appOptionsSchema.extend({
  id: z.union([z.string(), z.number()])
});

export const confirmSchema = z.object({
  confirm: z.literal(true)
});

export const mutationSchema = appOptionsSchema.extend({
  id: z.union([z.string(), z.number()]).optional(),
  body: z.record(z.string(), z.unknown()),
  confirm: z.literal(true)
});

export const restoreSchema = z.object({
  backupFile: z.string().min(1),
  app: appSchema.optional(),
  dryRun: z.boolean().default(true),
  confirm: z.literal(true).optional()
});

export const patchOperationSchema = z.object({
  app: appSchema,
  method: z.enum(["POST", "PUT", "DELETE"]),
  path: z.string().min(1),
  body: z.unknown().optional()
});

export const patchSchema = z.object({
  operations: z.array(patchOperationSchema).min(1),
  dryRun: z.boolean().default(true),
  confirm: z.literal(true).optional()
});
