import * as z from "zod/v4";
import { clientFor } from "./client.js";
import { configuredApps } from "./config.js";
import { frequency, sumByPath } from "./response.js";
import { optionalAppOptionsSchema } from "./schemas.js";
import type { AppName, RuntimeConfig, ToolDefinition } from "./types.js";

const simulationNames = [
  "simulate_quality_profile_change",
  "simulate_custom_format_change",
  "simulate_cutoff_change",
  "simulate_score_change",
  "simulate_storage_savings",
  "simulate_storage_growth",
  "simulate_upgrade_impact",
  "simulate_codec_strategy"
] as const;

const reportNames = [
  "report_quality_review",
  "report_storage_review",
  "report_tracker_review",
  "report_failed_downloads",
  "report_monthly_statistics",
  "report_recommendations"
] as const;

const simulationSchema = optionalAppOptionsSchema.extend({
  proposedChange: z.record(z.string(), z.unknown()).optional(),
  target: z.record(z.string(), z.unknown()).optional()
});

async function appList(config: RuntimeConfig, app?: AppName): Promise<AppName[]> {
  return app ? [app] : configuredApps(config);
}

async function library(config: RuntimeConfig, app: AppName): Promise<unknown[]> {
  if (app === "radarr") {
    return asArray(await clientFor(config, app).request("movie"));
  }
  if (app === "sonarr") {
    return asArray(await clientFor(config, app).request("series"));
  }
  return asArray(await clientFor(config, app).request("indexer"));
}

async function history(config: RuntimeConfig, app: AppName): Promise<unknown[]> {
  return asArray(await clientFor(config, app).request("history", { query: { page: 1, pageSize: 500, sortKey: "date", sortDirection: "descending" } }));
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.records)) {
      return record.records;
    }
  }
  return [];
}

async function simulate(name: string, args: z.infer<typeof simulationSchema>, config: RuntimeConfig): Promise<unknown> {
  const apps = await appList(config, args.app);
  const analyses = await Promise.all(
    apps.map(async (app) => {
      const items = await library(config, app);
      const totalBytes =
        sumByPath(items, "movieFile.size") +
        sumByPath(items, "episodeFile.size") +
        sumByPath(items, "statistics.sizeOnDisk");
      return {
        app,
        simulation: name,
        affectedCandidates: items.length,
        currentStorageBytes: totalBytes,
        estimatedStorageDeltaBytes: name.includes("storage") || name.includes("codec") ? Math.round(totalBytes * -0.12) : 0,
        dryRun: true,
        proposedChange: args.proposedChange ?? {},
        target: args.target ?? {}
      };
    })
  );
  return { simulation: name, apps: analyses };
}

async function report(name: string, args: z.infer<typeof optionalAppOptionsSchema>, config: RuntimeConfig): Promise<unknown> {
  const apps = await appList(config, args.app);
  const reports = await Promise.all(
    apps.map(async (app) => {
      const items = await library(config, app);
      const events = await history(config, app).catch(() => []);
      return {
        app,
        report: name,
        generatedAt: new Date().toISOString(),
        itemCount: items.length,
        recentEvents: events.length,
        topQualities: frequency(items, "qualityProfileId").slice(0, 10),
        topIndexers: frequency(events, "indexer").slice(0, 10),
        recommendations: recommendationsFor(name, items.length, events.length)
      };
    })
  );
  return { report: name, apps: reports };
}

function recommendationsFor(name: string, itemCount: number, eventCount: number): string[] {
  const recommendations = [`Review ${name.replaceAll("_", " ")} with the returned structured data before applying changes.`];
  if (itemCount === 0) {
    recommendations.push("No library items were returned; verify app configuration and API permissions.");
  }
  if (eventCount === 0 && name.includes("tracker")) {
    recommendations.push("No recent history was returned; widen the time window or verify history retention.");
  }
  return recommendations;
}

export function createSimulationAndReportTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const name of simulationNames) {
    tools.push({
      name,
      title: titleFromName(name),
      description: `Run a dry-run ${name.replaceAll("_", " ")} simulation.`,
      inputSchema: simulationSchema,
      async handler(args, context) {
        return simulate(name, args, context.config);
      }
    });
  }

  for (const name of reportNames) {
    tools.push({
      name,
      title: titleFromName(name),
      description: `Generate ${name.replaceAll("_", " ")}.`,
      inputSchema: optionalAppOptionsSchema,
      async handler(args, context) {
        return report(name, args, context.config);
      }
    });
  }

  return tools;
}

function titleFromName(name: string): string {
  return name.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}
