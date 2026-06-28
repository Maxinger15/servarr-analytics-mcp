import * as z from "zod/v4";
import { clientFor } from "./client.js";
import { mutationSchema } from "./schemas.js";
import type { ToolDefinition } from "./types.js";

type MutationSpec = {
  name: string;
  title: string;
  description: string;
  method: "POST" | "PUT" | "DELETE";
  path: string | ((args: z.infer<typeof mutationSchema>) => string);
  bulk?: boolean;
};

const mutationSpecs: MutationSpec[] = [
  {
    name: "update_quality_profile",
    title: "Update Quality Profile",
    description: "Update a quality profile by id.",
    method: "PUT",
    path: (args) => `qualityprofile/${args.id}`
  },
  {
    name: "create_quality_profile",
    title: "Create Quality Profile",
    description: "Create a quality profile.",
    method: "POST",
    path: "qualityprofile"
  },
  {
    name: "clone_quality_profile",
    title: "Clone Quality Profile",
    description: "Clone a quality profile using the provided body.",
    method: "POST",
    path: "qualityprofile"
  },
  {
    name: "delete_quality_profile",
    title: "Delete Quality Profile",
    description: "Delete a quality profile by id.",
    method: "DELETE",
    path: (args) => `qualityprofile/${args.id}`
  },
  {
    name: "update_custom_format",
    title: "Update Custom Format",
    description: "Update a custom format by id.",
    method: "PUT",
    path: (args) => `customformat/${args.id}`
  },
  {
    name: "update_custom_format_score",
    title: "Update Custom Format Score",
    description: "Update custom format score data using the provided body.",
    method: "PUT",
    path: (args) => `customformat/${args.id}`
  },
  {
    name: "bulk_update_scores",
    title: "Bulk Update Scores",
    description: "Bulk update custom format scores from body.updates.",
    method: "PUT",
    path: "customformat",
    bulk: true
  },
  {
    name: "update_quality_definition",
    title: "Update Quality Definition",
    description: "Update a quality definition by id.",
    method: "PUT",
    path: (args) => `qualitydefinition/${args.id}`
  },
  {
    name: "update_delay_profile",
    title: "Update Delay Profile",
    description: "Update a delay profile by id.",
    method: "PUT",
    path: (args) => `delayprofile/${args.id}`
  },
  {
    name: "update_naming",
    title: "Update Naming",
    description: "Update naming configuration.",
    method: "PUT",
    path: "config/naming"
  },
  {
    name: "update_media_management",
    title: "Update Media Management",
    description: "Update media management configuration.",
    method: "PUT",
    path: "config/mediamanagement"
  },
  {
    name: "update_restrictions",
    title: "Update Restrictions",
    description: "Update release restrictions.",
    method: "PUT",
    path: (args) => `restriction/${args.id}`
  }
];

export function createMutationTools(): ToolDefinition[] {
  return mutationSpecs.map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: `${spec.description} Requires confirm=true.`,
    inputSchema: mutationSchema,
    async handler(args, context) {
      if (args.confirm !== true) {
        return { applied: false, message: "Mutating tools require confirm=true." };
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
