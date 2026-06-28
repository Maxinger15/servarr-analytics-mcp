import * as z from "zod/v4";
import { clientFor } from "./client.js";
import { mutationSchema } from "./schemas.js";
import type { AppName, ToolDefinition } from "./types.js";

type MutationArgs = z.infer<typeof mutationSchema>;
type JsonRecord = Record<string, unknown>;

type MutationSpec = {
  name: string;
  title: string;
  description: string;
  method: "POST" | "PUT" | "DELETE";
  path: string | ((args: MutationArgs) => string);
  bulk?: boolean;
  supportedApps?: AppName[];
  customHandler?: (args: MutationArgs, context: Parameters<ToolDefinition["handler"]>[1]) => Promise<unknown>;
};

const MEDIA_APPS: AppName[] = ["sonarr", "radarr"];

const mutationSpecs: MutationSpec[] = [
  {
    name: "update_quality_profile",
    title: "Update Quality Profile",
    description: "Update a quality profile by id.",
    method: "PUT",
    path: (args) => `qualityprofile/${args.id}`,
    supportedApps: MEDIA_APPS
  },
  {
    name: "create_quality_profile",
    title: "Create Quality Profile",
    description: "Create a quality profile.",
    method: "POST",
    path: "qualityprofile",
    supportedApps: MEDIA_APPS
  },
  {
    name: "clone_quality_profile",
    title: "Clone Quality Profile",
    description: "Clone a quality profile using the provided body.",
    method: "POST",
    path: "qualityprofile",
    supportedApps: MEDIA_APPS,
    customHandler: cloneQualityProfile
  },
  {
    name: "delete_quality_profile",
    title: "Delete Quality Profile",
    description: "Delete a quality profile by id.",
    method: "DELETE",
    path: (args) => `qualityprofile/${args.id}`,
    supportedApps: MEDIA_APPS
  },
  {
    name: "update_custom_format",
    title: "Update Custom Format",
    description: "Update a custom format by id.",
    method: "PUT",
    path: (args) => `customformat/${args.id}`,
    supportedApps: MEDIA_APPS
  },
  {
    name: "update_custom_format_score",
    title: "Update Custom Format Score",
    description: "Update custom format score data using the provided body.",
    method: "PUT",
    path: "qualityprofile",
    supportedApps: MEDIA_APPS,
    customHandler: updateCustomFormatScore
  },
  {
    name: "bulk_update_scores",
    title: "Bulk Update Scores",
    description: "Bulk update custom format scores from body.updates.",
    method: "PUT",
    path: "customformat",
    bulk: true,
    supportedApps: MEDIA_APPS,
    customHandler: bulkUpdateScores
  },
  {
    name: "update_quality_definition",
    title: "Update Quality Definition",
    description: "Update a quality definition by id.",
    method: "PUT",
    path: (args) => `qualitydefinition/${args.id}`,
    supportedApps: MEDIA_APPS
  },
  {
    name: "update_delay_profile",
    title: "Update Delay Profile",
    description: "Update a delay profile by id.",
    method: "PUT",
    path: (args) => `delayprofile/${args.id}`,
    supportedApps: MEDIA_APPS
  },
  {
    name: "update_naming",
    title: "Update Naming",
    description: "Update naming configuration.",
    method: "PUT",
    path: "config/naming",
    supportedApps: MEDIA_APPS
  },
  {
    name: "update_media_management",
    title: "Update Media Management",
    description: "Update media management configuration.",
    method: "PUT",
    path: "config/mediamanagement",
    supportedApps: MEDIA_APPS
  },
  {
    name: "update_restrictions",
    title: "Update Restrictions",
    description: "Update release profile restrictions.",
    method: "PUT",
    path: (args) => `releaseprofile/${args.id}`,
    supportedApps: MEDIA_APPS
  }
];

export function createMutationTools(): ToolDefinition[] {
  return mutationSpecs.map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: `${spec.description} Requires confirm=true${spec.bulk ? " and dryRun=false" : ""}.`,
    inputSchema: mutationSchema,
    async handler(args, context) {
      if (args.confirm !== true) {
        return { applied: false, message: "Mutating tools require confirm=true." };
      }
      if (spec.supportedApps && !spec.supportedApps.includes(args.app)) {
        throw new Error(`${spec.name} is not supported for ${args.app}. Supported apps: ${spec.supportedApps.join(", ")}.`);
      }

      if (spec.customHandler) {
        return spec.customHandler(args, context);
      }

      if (spec.bulk) {
        const updates = Array.isArray(args.body.updates) ? args.body.updates : [];
        if (updates.length === 0) {
          throw new Error("Bulk operations require body.updates with at least one item.");
        }
        const results = [];
        for (const update of updates) {
          if (!update || typeof update !== "object" || !("id" in update)) {
            throw new Error("Each bulk update requires an id.");
          }
          const id = (update as { id: string | number }).id;
          const result = await clientFor(context.config, args.app).request(`customformat/${id}`, {
            method: spec.method,
            body: update
          });
          results.push({ id, result });
        }
        return { applied: results.length, results };
      }

      const path = typeof spec.path === "function" ? spec.path(args) : spec.path;
      if (path.includes("undefined")) {
        throw new Error(`${spec.name} requires id.`);
      }
      const result = await clientFor(context.config, args.app).request(path, {
        method: spec.method,
        body: spec.method === "DELETE" ? undefined : args.body
      });
      return { applied: true, app: args.app, endpoint: path, result };
    }
  }));
}

async function cloneQualityProfile(args: MutationArgs, context: Parameters<ToolDefinition["handler"]>[1]): Promise<unknown> {
  const body = { ...args.body };
  if (args.id !== undefined) {
    const source = await clientFor(context.config, args.app).request<JsonRecord>(`qualityprofile/${args.id}`);
    delete source.id;
    Object.assign(source, body);
    if (!source.name || source.name === body.name) {
      source.name = typeof body.name === "string" && body.name.trim() ? body.name : `${String((source as JsonRecord).name ?? "Quality Profile")} Copy`;
    }
    const result = await clientFor(context.config, args.app).request("qualityprofile", { method: "POST", body: source });
    return { applied: true, app: args.app, endpoint: "qualityprofile", clonedFrom: args.id, result };
  }

  const result = await clientFor(context.config, args.app).request("qualityprofile", { method: "POST", body });
  return { applied: true, app: args.app, endpoint: "qualityprofile", result };
}

async function updateCustomFormatScore(args: MutationArgs, context: Parameters<ToolDefinition["handler"]>[1]): Promise<unknown> {
  const qualityProfileId = requiredNumber(args.body.qualityProfileId, "body.qualityProfileId");
  const customFormatId = requiredNumber(args.id ?? args.body.customFormatId ?? args.body.formatId ?? args.body.format, "id or body.customFormatId");
  const score = requiredNumber(args.body.score, "body.score");
  const profile = await clientFor(context.config, args.app).request<JsonRecord>(`qualityprofile/${qualityProfileId}`);
  const updated = updateProfileFormatScore(profile, customFormatId, score);
  const result = await clientFor(context.config, args.app).request(`qualityprofile/${qualityProfileId}`, {
    method: "PUT",
    body: updated
  });
  return { applied: true, app: args.app, endpoint: `qualityprofile/${qualityProfileId}`, customFormatId, score, result };
}

async function bulkUpdateScores(args: MutationArgs, context: Parameters<ToolDefinition["handler"]>[1]): Promise<unknown> {
  const qualityProfileId = requiredNumber(args.body.qualityProfileId, "body.qualityProfileId");
  const updates = Array.isArray(args.body.updates) ? args.body.updates : [];
  if (updates.length === 0) {
    throw new Error("bulk_update_scores requires body.updates with at least one score update.");
  }
  const planned = updates.map((update) => {
    if (!update || typeof update !== "object") {
      throw new Error("Each score update must be an object.");
    }
    const record = update as JsonRecord;
    return {
      customFormatId: requiredNumber(record.customFormatId ?? record.formatId ?? record.format ?? record.id, "updates[].customFormatId"),
      score: requiredNumber(record.score, "updates[].score")
    };
  });

  if (args.dryRun !== false) {
    return {
      dryRun: true,
      applied: 0,
      app: args.app,
      endpoint: `qualityprofile/${qualityProfileId}`,
      updates: planned,
      message: "Bulk operations require dryRun=false in addition to confirm=true."
    };
  }

  const profile = await clientFor(context.config, args.app).request<JsonRecord>(`qualityprofile/${qualityProfileId}`);
  let updated = profile;
  for (const { customFormatId, score } of planned) {
    updated = updateProfileFormatScore(updated, customFormatId, score);
  }
  const result = await clientFor(context.config, args.app).request(`qualityprofile/${qualityProfileId}`, {
    method: "PUT",
    body: updated
  });
  return { applied: planned.length, app: args.app, endpoint: `qualityprofile/${qualityProfileId}`, updates: planned, result };
}

function updateProfileFormatScore(profile: JsonRecord, customFormatId: number, score: number): JsonRecord {
  const formatItems = profile.formatItems;
  if (!Array.isArray(formatItems)) {
    throw new Error("Quality profile does not contain formatItems; this app/version may not support custom format scores.");
  }
  let found = false;
  const nextFormatItems = formatItems.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const record = item as JsonRecord;
    const rawFormatId = record.format ?? record.formatId ?? record.id;
    if (Number(rawFormatId) !== customFormatId) {
      return item;
    }
    found = true;
    return { ...record, score };
  });
  if (!found) {
    throw new Error(`Custom format ${customFormatId} is not present in quality profile ${String(profile.id ?? "")}.`);
  }
  return { ...profile, formatItems: nextFormatItems };
}

function requiredNumber(value: unknown, name: string): number {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${name} must be a number.`);
  }
  return numberValue;
}
