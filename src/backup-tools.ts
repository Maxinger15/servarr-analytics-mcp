import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as z from "zod/v4";
import { clientFor } from "./client.js";
import { configuredApps, ensureBackupDir } from "./config.js";
import { patchSchema, restoreSchema } from "./schemas.js";
import type { AppName, BackupFile, PatchOperation, ToolDefinition } from "./types.js";

const backupEndpoints = [
  "qualityprofile",
  "qualitydefinition",
  "customformat",
  "delayprofile",
  "tag",
  "rootfolder",
  "downloadclient",
  "indexer",
  "notification",
  "config/naming",
  "config/mediamanagement",
  "config/host"
] as const;

const collectionEndpoints = new Set<string>([
  "qualityprofile",
  "qualitydefinition",
  "customformat",
  "delayprofile",
  "tag",
  "rootfolder",
  "downloadclient",
  "indexer",
  "notification"
]);

const singletonEndpoints = new Set<string>([
  "config/naming",
  "config/mediamanagement",
  "config/host"
]);

export function createBackupTools(): ToolDefinition[] {
  return [
    {
      name: "create_backup",
      title: "Create Backup",
      description: "Create a local JSON backup of Servarr configuration endpoints.",
      inputSchema: z.object({ app: z.enum(["sonarr", "radarr", "prowlarr"]).optional() }),
      async handler(args, context) {
        await ensureBackupDir(context.config);
        const apps = args.app ? [args.app] : configuredApps(context.config);
        const data: Record<string, unknown> = {};

        for (const app of apps) {
          for (const endpoint of backupEndpoints) {
            try {
              data[`${app}:${endpoint}`] = await clientFor(context.config, app).request(endpoint);
            } catch (error) {
              data[`${app}:${endpoint}`] = { error: error instanceof Error ? error.message : String(error) };
            }
          }
        }

        const backup: BackupFile = {
          version: 1,
          createdAt: new Date().toISOString(),
          apps,
          data
        };
        const file = join(context.config.backupDir, `servarr-backup-${backup.createdAt.replaceAll(":", "-")}.json`);
        await writeFile(file, JSON.stringify(backup, null, 2), "utf8");
        return { file, apps, endpoints: backupEndpoints.length };
      }
    },
    {
      name: "list_backups",
      title: "List Backups",
      description: "List local Servarr Analytics MCP backup files.",
      inputSchema: z.object({}),
      async handler(_args, context) {
        await ensureBackupDir(context.config);
        const files = await readdir(context.config.backupDir);
        return {
          backupDir: context.config.backupDir,
          backups: files.filter((file) => file.endsWith(".json")).sort()
        };
      }
    },
    {
      name: "restore_backup",
      title: "Restore Backup",
      description: "Plan or restore a backup. Actual restore requires confirm true and dryRun false.",
      inputSchema: restoreSchema,
      async handler(args, context) {
        const backup = await readBackup(context.config.backupDir, args.backupFile);
        const operations = backupToPatch(backup, args.app);
        if (args.dryRun !== false || args.confirm !== true) {
          return { dryRun: true, operations, message: "Set dryRun=false and confirm=true to restore." };
        }
        if (!args.app) {
          throw new Error("Restoring a backup requires a specific app target.");
        }
        return applyOperations(context.config, operations);
      }
    },
    {
      name: "generate_diff",
      title: "Generate Diff",
      description: "Compare a backup against current Servarr configuration.",
      inputSchema: z.object({ backupFile: z.string().min(1), app: z.enum(["sonarr", "radarr", "prowlarr"]).optional() }),
      async handler(args, context) {
        const backup = await readBackup(context.config.backupDir, args.backupFile);
        const apps = args.app ? [args.app] : backup.apps;
        const changes = [];
        for (const app of apps) {
          for (const endpoint of backupEndpoints) {
            const key = `${app}:${endpoint}`;
            const current = await clientFor(context.config, app).request(endpoint).catch((error: unknown) => ({
              error: error instanceof Error ? error.message : String(error)
            }));
            changes.push({
              app,
              endpoint,
              changed: JSON.stringify(backup.data[key]) !== JSON.stringify(current)
            });
          }
        }
        return { backupFile: basename(args.backupFile), changes };
      }
    },
    {
      name: "validate_patch",
      title: "Validate Patch",
      description: "Validate patch operations without applying them.",
      inputSchema: patchSchema,
      async handler(args) {
        return validatePatchOperations(args.operations);
      }
    },
    {
      name: "dry_run_patch",
      title: "Dry Run Patch",
      description: "Show patch operations that would be applied.",
      inputSchema: patchSchema,
      async handler(args) {
        return { dryRun: true, validation: validatePatchOperations(args.operations), operations: args.operations };
      }
    },
    {
      name: "apply_patch",
      title: "Apply Patch",
      description: "Apply patch operations. Requires confirm true and dryRun false.",
      inputSchema: patchSchema,
      async handler(args, context) {
        if (args.dryRun !== false || args.confirm !== true) {
          return { dryRun: true, operations: args.operations, message: "Set dryRun=false and confirm=true to apply." };
        }
        validatePatchOperations(args.operations);
        return applyOperations(context.config, args.operations);
      }
    }
  ];
}

async function readBackup(backupDir: string, file: string): Promise<BackupFile> {
  const path = join(backupDir, basename(file));
  const parsed = JSON.parse(await readFile(path, "utf8")) as BackupFile;
  if (parsed.version !== 1 || !parsed.data) {
    throw new Error("Unsupported backup file");
  }
  return parsed;
}

function backupToPatch(backup: BackupFile, onlyApp?: AppName): PatchOperation[] {
  const operations: PatchOperation[] = [];
  const apps = onlyApp ? [onlyApp] : backup.apps;
  for (const app of apps) {
    for (const endpoint of backupEndpoints) {
      const body = backup.data[`${app}:${endpoint}`];
      if (body !== undefined && !(body && typeof body === "object" && "error" in body)) {
        operations.push(...backupEndpointToOperations(app, endpoint, body));
      }
    }
  }
  return operations;
}

function backupEndpointToOperations(app: AppName, endpoint: string, body: unknown): PatchOperation[] {
  if (singletonEndpoints.has(endpoint)) {
    return [{ app, method: "PUT", path: endpoint, body }];
  }

  if (!Array.isArray(body)) {
    return collectionEndpoints.has(endpoint) && hasId(body)
      ? [{ app, method: "PUT", path: `${endpoint}/${body.id}`, body }]
      : [];
  }

  if (!collectionEndpoints.has(endpoint)) {
    return [];
  }

  return body
    .filter(hasId)
    .map((item) => ({ app, method: "PUT" as const, path: `${endpoint}/${item.id}`, body: item }));
}

export function validatePatchOperations(operations: PatchOperation[]): { valid: true; operations: number } {
  for (const operation of operations) {
    const normalizedPath = operation.path.replace(/^\/+/, "");
    const [collection, id, extra] = normalizedPath.split("/");
    const singleton = `${collection}/${id}`;

    if (extra) {
      throw new Error(`Nested patch paths are not supported: ${operation.path}`);
    }
    if (singletonEndpoints.has(singleton)) {
      if (operation.method !== "PUT") {
        throw new Error(`Singleton endpoint ${singleton} only supports PUT patches.`);
      }
      continue;
    }
    if (!collectionEndpoints.has(collection ?? "")) {
      throw new Error(`Patch path is not in the safe allowlist: ${operation.path}`);
    }
    if (operation.method !== "POST" && !id) {
      throw new Error(`Patch operation ${operation.method} ${operation.path} requires a specific item id.`);
    }
    if (operation.method !== "DELETE" && operation.body === undefined) {
      throw new Error(`Patch operation ${operation.method} ${operation.path} requires a body.`);
    }
  }
  return { valid: true, operations: operations.length };
}

function hasId(value: unknown): value is { id: string | number } {
  return Boolean(value && typeof value === "object" && "id" in value && (typeof (value as { id: unknown }).id === "string" || typeof (value as { id: unknown }).id === "number"));
}

async function applyOperations(config: Parameters<typeof clientFor>[0], operations: PatchOperation[]): Promise<unknown> {
  const results = [];
  for (const operation of operations) {
    const result = await clientFor(config, operation.app).request(operation.path, {
      method: operation.method,
      body: operation.body
    });
    results.push({ operation, result });
  }
  return { applied: results.length, results };
}
