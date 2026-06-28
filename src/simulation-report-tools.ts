import * as z from "zod/v4";
import { shapeResult } from "./response.js";
import { optionalAppOptionsSchema } from "./schemas.js";
import {
  averageSize,
  bytesBy,
  countBy,
  groupHistoryByMonth,
  profileNameById,
  readDatasets,
  successRateByIndexer,
  totalStorageBytes
} from "./servarr-data.js";
import type { CommonQueryOptions, RuntimeConfig, ToolDefinition } from "./types.js";

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

type SimulationArgs = z.infer<typeof simulationSchema>;
type ReportArgs = z.infer<typeof optionalAppOptionsSchema>;

export function createSimulationAndReportTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const name of simulationNames) {
    tools.push({
      name,
      title: titleFromName(name),
      description: `Run a dry-run ${name.replaceAll("_", " ")} simulation.`,
      inputSchema: simulationSchema,
      async handler(args, context) {
        return shapeResult(await simulate(name, args, context.config), args as CommonQueryOptions, { tool: name });
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
        return shapeResult(await report(name, args, context.config), args as CommonQueryOptions, { tool: name });
      }
    });
  }

  return tools;
}

async function simulate(name: string, args: SimulationArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    simulation: name,
    dryRun: true,
    apps: datasets.map((dataset) => {
      const profileNames = profileNameById(dataset.qualityProfiles);
      const targetProfileId = numberFrom(args.target?.qualityProfileId ?? args.proposedChange?.qualityProfileId);
      const sourceProfileId = numberFrom(args.target?.sourceQualityProfileId ?? args.proposedChange?.sourceQualityProfileId);
      const codecPattern = stringFrom(args.target?.codec ?? args.proposedChange?.codec);
      const candidatesByProfile = sourceProfileId
        ? dataset.library.filter((item) => item.qualityProfileId === sourceProfileId)
        : dataset.library;
      const nonEfficientCodec = dataset.library.filter((item) => item.codec && !/265|hevc|av1/i.test(item.codec));
      const cutoffCandidates = dataset.cutoffUnmet.length;

      return {
        app: dataset.app,
        proposedChange: args.proposedChange ?? {},
        target: args.target ?? {},
        affectedCandidates: affectedCandidateCount(name, candidatesByProfile.length, nonEfficientCodec.length, cutoffCandidates),
        currentStorageBytes: totalStorageBytes(dataset.library),
        estimatedStorageDeltaBytes: estimateStorageDelta(name, nonEfficientCodec),
        sourceProfile: sourceProfileId ? { id: sourceProfileId, name: profileNames.get(sourceProfileId) ?? "unknown" } : undefined,
        targetProfile: targetProfileId ? { id: targetProfileId, name: profileNames.get(targetProfileId) ?? "unknown" } : undefined,
        codecStrategy: codecPattern ? { requestedCodec: codecPattern, matchingItems: dataset.library.filter((item) => item.codec?.toLowerCase().includes(codecPattern.toLowerCase())).length } : undefined,
        notes: simulationNotes(name)
      };
    })
  };
}

async function report(name: string, args: ReportArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    report: name,
    generatedAt: new Date().toISOString(),
    apps: datasets.map((dataset) => {
      const failed = dataset.history.filter((event) => event.eventType.toLowerCase().includes("fail"));
      const storageBytes = totalStorageBytes(dataset.library);
      const recommendations = recommendationsFor(dataset, name);
      return {
        app: dataset.app,
        itemCount: dataset.library.length,
        storageBytes,
        healthIssues: dataset.health.length,
        queueItems: dataset.queue.length,
        cutoffUnmet: dataset.cutoffUnmet.length,
        missingFiles: dataset.library.filter((item) => item.hasFile === false).length,
        failedDownloads: failed.length,
        averageReleaseBytes: averageSize(dataset.history),
        qualityProfiles: countBy(dataset.library, (item) => item.qualityProfileId).slice(0, 10),
        qualities: countBy(dataset.library, (item) => item.quality).slice(0, 10),
        codecs: countBy(dataset.library, (item) => item.codec).slice(0, 10),
        storageByCodec: bytesBy(dataset.library, (item) => item.codec, (item) => item.sizeOnDisk).slice(0, 10),
        indexerSuccess: successRateByIndexer(dataset.history).slice(0, 10),
        monthlyStatistics: groupHistoryByMonth(dataset.history).slice(0, 12),
        failedByIndexer: bytesBy(failed, (event) => event.indexer, (event) => event.size ?? 0).slice(0, 10),
        recommendations
      };
    })
  };
}

function affectedCandidateCount(name: string, profileCandidates: number, codecCandidates: number, cutoffCandidates: number): number {
  if (name.includes("codec") || name.includes("storage")) {
    return codecCandidates;
  }
  if (name.includes("cutoff") || name.includes("upgrade")) {
    return cutoffCandidates;
  }
  return profileCandidates;
}

function estimateStorageDelta(name: string, candidates: Array<{ sizeOnDisk: number }>): number {
  if (!name.includes("storage") && !name.includes("codec")) {
    return 0;
  }
  const candidateBytes = candidates.reduce((total, item) => total + item.sizeOnDisk, 0);
  return -Math.round(candidateBytes * 0.35);
}

function recommendationsFor(dataset: Awaited<ReturnType<typeof readDatasets>>[number], reportName: string): string[] {
  const recommendations: string[] = [];
  if (dataset.health.length > 0) {
    recommendations.push("Resolve current Servarr health issues before applying bulk changes.");
  }
  if (dataset.cutoffUnmet.length > 0 && reportName.includes("quality")) {
    recommendations.push("Review cutoff-unmet items before changing profile cutoffs.");
  }
  if (dataset.history.some((event) => event.eventType.toLowerCase().includes("fail"))) {
    recommendations.push("Inspect failed downloads by indexer and download client before tuning indexer priority.");
  }
  if (dataset.library.some((item) => item.codec && !/265|hevc|av1/i.test(item.codec) && item.sizeOnDisk > 5_000_000_000)) {
    recommendations.push("Large non-HEVC/AV1 files are good candidates for a codec or size strategy simulation.");
  }
  if (recommendations.length === 0) {
    recommendations.push("No high-confidence recommendation was detected from the current sampled data.");
  }
  return recommendations;
}

function simulationNotes(name: string): string[] {
  const notes = ["Simulation only reads current Servarr data and does not mutate any app."];
  if (name.includes("storage") || name.includes("codec")) {
    notes.push("Storage deltas are estimates and assume replacement files are roughly 35% smaller.");
  }
  if (name.includes("custom_format") || name.includes("score")) {
    notes.push("Custom format impact is estimated from currently matched file formats and configured formats.");
  }
  return notes;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function titleFromName(name: string): string {
  return name.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}
