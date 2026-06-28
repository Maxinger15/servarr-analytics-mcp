import * as z from "zod/v4";
import { shapeResult } from "./response.js";
import { optionalAppOptionsSchema } from "./schemas.js";
import {
  averageSize,
  bytesBy,
  countBy,
  duplicateValues,
  groupHistoryByMonth,
  profileNameById,
  readDatasets,
  successRateByIndexer,
  totalStorageBytes
} from "./servarr-data.js";
import type { CommonQueryOptions, RuntimeConfig, ToolDefinition } from "./types.js";

type AnalyticsArgs = z.infer<typeof optionalAppOptionsSchema>;

function analyticsTool(
  name: string,
  title: string,
  description: string,
  run: (args: AnalyticsArgs, config: RuntimeConfig) => Promise<unknown>
): ToolDefinition {
  return {
    name,
    title,
    description,
    inputSchema: optionalAppOptionsSchema,
    async handler(args, context) {
      const data = await run(args, context.config);
      return shapeResult(data, args as CommonQueryOptions, { tool: name });
    }
  };
}

export function createAnalyticsTools(): ToolDefinition[] {
  return [
    analyticsTool("library_summary", "Library Summary", "Summarize configured Servarr libraries.", summarizeLibrary),
    analyticsTool("library_storage_stats", "Library Storage Stats", "Summarize storage usage by library.", storageUsage),
    analyticsTool("library_codec_distribution", "Library Codec Distribution", "Summarize video codec distribution.", (args, config) => itemDistribution(args, config, "codec")),
    analyticsTool("library_resolution_distribution", "Library Resolution Distribution", "Summarize resolution distribution.", (args, config) => itemDistribution(args, config, "qualityResolution")),
    analyticsTool("library_hdr_distribution", "Library HDR Distribution", "Summarize HDR/dynamic range distribution.", (args, config) => itemDistribution(args, config, "hdr")),
    analyticsTool("library_audio_distribution", "Library Audio Distribution", "Summarize audio codec distribution.", (args, config) => itemDistribution(args, config, "audioCodec")),
    analyticsTool("library_quality_distribution", "Library Quality Distribution", "Summarize quality distribution.", (args, config) => itemDistribution(args, config, "quality")),
    analyticsTool("library_profile_usage", "Library Profile Usage", "Summarize quality profile usage.", profileUsage),
    analyticsTool("library_growth_statistics", "Library Growth Statistics", "Estimate growth from added dates and recent imports.", growthStatistics),
    analyticsTool("quality_profile_usage", "Quality Profile Usage", "Count library items per quality profile.", profileUsage),
    analyticsTool("quality_distribution", "Quality Distribution", "Count library items by current file quality.", (args, config) => itemDistribution(args, config, "quality")),
    analyticsTool("codec_distribution", "Codec Distribution", "Count library items by video codec.", (args, config) => itemDistribution(args, config, "codec")),
    analyticsTool("resolution_distribution", "Resolution Distribution", "Count library items by resolution.", (args, config) => itemDistribution(args, config, "qualityResolution")),
    analyticsTool("hdr_distribution", "HDR Distribution", "Count library items by HDR/dynamic range.", (args, config) => itemDistribution(args, config, "hdr")),
    analyticsTool("audio_distribution", "Audio Distribution", "Count library items by audio codec.", (args, config) => itemDistribution(args, config, "audioCodec")),
    analyticsTool("cutoff_unmet_by_profile", "Cutoff Unmet By Profile", "Group cutoff-unmet items by quality profile when available.", cutoffUnmetByProfile),
    analyticsTool("upgrade_candidates", "Upgrade Candidates", "List monitored items missing files or below cutoff.", upgradeCandidates),
    analyticsTool("profile_overlap", "Profile Overlap", "Find quality profiles with identical quality sets.", profileOverlap),
    analyticsTool("redundant_quality_profiles", "Redundant Quality Profiles", "Find unused or duplicate quality profiles.", redundantQualityProfiles),
    analyticsTool("custom_format_hits", "Custom Format Hits", "Count matched custom formats in library files.", customFormatHits),
    analyticsTool("custom_format_misses", "Custom Format Misses", "List configured custom formats not seen in library files.", customFormatMisses),
    analyticsTool("unused_custom_formats", "Unused Custom Formats", "Alias for custom format misses.", customFormatMisses),
    analyticsTool("duplicate_custom_formats", "Duplicate Custom Formats", "Find custom formats with duplicate names.", duplicateCustomFormats),
    analyticsTool("conflicting_custom_formats", "Conflicting Custom Formats", "Find custom formats sharing equivalent specification counts and names.", conflictingCustomFormats),
    analyticsTool("storage_usage", "Storage Usage", "Summarize storage usage.", storageUsage),
    analyticsTool("storage_by_codec", "Storage By Codec", "Group storage by codec.", (args, config) => storageBy(args, config, "codec")),
    analyticsTool("storage_by_quality", "Storage By Quality", "Group storage by quality.", (args, config) => storageBy(args, config, "quality")),
    analyticsTool("storage_by_resolution", "Storage By Resolution", "Group storage by resolution.", (args, config) => storageBy(args, config, "qualityResolution")),
    analyticsTool("storage_growth", "Storage Growth", "Estimate storage growth from history.", growthStatistics),
    analyticsTool("estimated_storage_savings", "Estimated Storage Savings", "Estimate savings candidates from large non-HEVC files.", estimatedStorageSavings),
    analyticsTool("download_volume_by_indexer", "Download Volume By Indexer", "Sum history download volume by indexer.", downloadVolumeByIndexer),
    analyticsTool("grabs_by_indexer", "Grabs By Indexer", "Count grab events by indexer.", (args, config) => historyDistribution(args, config, "indexer", "grab")),
    analyticsTool("imports_by_indexer", "Imports By Indexer", "Count import events by indexer.", (args, config) => historyDistribution(args, config, "indexer", "import")),
    analyticsTool("failed_downloads_by_indexer", "Failed Downloads By Indexer", "Count failed downloads by indexer.", (args, config) => historyDistribution(args, config, "indexer", "fail")),
    analyticsTool("success_rate_by_indexer", "Success Rate By Indexer", "Estimate indexer success rate from grab/import/failure history.", successRate),
    analyticsTool("average_release_size", "Average Release Size", "Average release size from history data.", averageReleaseSize),
    analyticsTool("quality_by_indexer", "Quality By Indexer", "Group history qualities by indexer.", (args, config) => historyMatrix(args, config, "quality")),
    analyticsTool("codec_by_indexer", "Codec By Indexer", "Group history codec hints by indexer when available.", (args, config) => historyMatrix(args, config, "raw.data.videoCodec")),
    analyticsTool("language_by_indexer", "Language By Indexer", "Group history languages by indexer.", (args, config) => historyMatrix(args, config, "language")),
    analyticsTool("release_group_by_indexer", "Release Group By Indexer", "Group release groups by indexer.", (args, config) => historyMatrix(args, config, "releaseGroup")),
    analyticsTool("duplicate_grabs", "Duplicate Grabs", "Find repeated grabs with the same download id or title.", duplicateGrabs),
    analyticsTool("wasted_downloads", "Wasted Downloads", "Estimate failed or non-imported grab volume.", wastedDownloads)
  ];
}

async function summarizeLibrary(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => ({
      app: dataset.app,
      items: dataset.library.length,
      monitoredItems: dataset.library.filter((item) => item.monitored).length,
      itemsWithFiles: dataset.library.filter((item) => item.hasFile !== false && item.sizeOnDisk > 0).length,
      storageBytes: totalStorageBytes(dataset.library),
      queueItems: dataset.queue.length,
      healthIssues: dataset.health.length,
      qualities: countBy(dataset.library, (item) => item.quality).slice(0, 10),
      codecs: countBy(dataset.library, (item) => item.codec).slice(0, 10),
      profiles: withProfileNames(dataset)
    }))
  };
}

async function itemDistribution(args: AnalyticsArgs, config: RuntimeConfig, field: keyof Awaited<ReturnType<typeof readDatasets>>[number]["library"][number]): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, field, distribution: countBy(dataset.library, (item) => item[field] as string | number | undefined) })) };
}

async function profileUsage(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, profiles: withProfileNames(dataset) })) };
}

async function cutoffUnmetByProfile(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, cutoffUnmet: dataset.cutoffUnmet.length, profiles: countBy(dataset.cutoffUnmet, (item) => String((item as Record<string, unknown>).qualityProfileId ?? "unknown")) })) };
}

async function upgradeCandidates(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => ({
      app: dataset.app,
      missingOrNoFile: dataset.library.filter((item) => item.hasFile === false),
      cutoffUnmet: dataset.cutoffUnmet,
      largeNonHevc: dataset.library.filter((item) => item.sizeOnDisk > 5_000_000_000 && item.codec && !/265|hevc/i.test(item.codec)).slice(0, 50)
    }))
  };
}

async function profileOverlap(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => {
      const bySignature = new Map<string, string[]>();
      for (const profile of dataset.qualityProfiles) {
        const signature = profile.qualities.slice().sort().join("|");
        bySignature.set(signature, [...(bySignature.get(signature) ?? []), profile.name]);
      }
      return { app: dataset.app, overlaps: [...bySignature.entries()].filter(([, names]) => names.length > 1).map(([qualities, profiles]) => ({ qualities, profiles })) };
    })
  };
}

async function redundantQualityProfiles(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => {
      const used = new Set(dataset.library.map((item) => item.qualityProfileId).filter((id): id is number => id !== undefined));
      return {
        app: dataset.app,
        unusedProfiles: dataset.qualityProfiles.filter((profile) => profile.id !== undefined && !used.has(profile.id)),
        duplicateNames: duplicateValues(dataset.qualityProfiles.map((profile) => profile.name))
      };
    })
  };
}

async function customFormatHits(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, hits: countBy(dataset.library.flatMap((item) => item.customFormats), (item) => item) })) };
}

async function customFormatMisses(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => {
      const hitNames = new Set(dataset.library.flatMap((item) => item.customFormats));
      return { app: dataset.app, misses: dataset.customFormats.filter((format) => !hitNames.has(format.name)) };
    })
  };
}

async function duplicateCustomFormats(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, duplicateNames: duplicateValues(dataset.customFormats.map((format) => format.name)) })) };
}

async function conflictingCustomFormats(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => ({
      app: dataset.app,
      possibleConflicts: dataset.customFormats
        .filter((format) => format.specificationCount === 0)
        .map((format) => ({ id: format.id, name: format.name, reason: "Custom format has no specifications." }))
    }))
  };
}

async function storageUsage(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, totalBytes: totalStorageBytes(dataset.library), items: dataset.library.length })) };
}

async function storageBy(args: AnalyticsArgs, config: RuntimeConfig, field: "codec" | "quality" | "qualityResolution"): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, field, distribution: bytesBy(dataset.library, (item) => item[field], (item) => item.sizeOnDisk) })) };
}

async function growthStatistics(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, byAddedMonth: countBy(dataset.library, (item) => item.added?.slice(0, 7)), byHistoryMonth: groupHistoryByMonth(dataset.history).slice(0, 24) })) };
}

async function estimatedStorageSavings(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => {
      const candidates = dataset.library.filter((item) => item.sizeOnDisk > 0 && item.codec && !/265|hevc/i.test(item.codec));
      return {
        app: dataset.app,
        candidates: candidates.length,
        candidateBytes: totalStorageBytes(candidates),
        estimatedSavingsBytes: Math.round(totalStorageBytes(candidates) * 0.35),
        assumption: "Estimates a 35% reduction for non-HEVC/x265 files when replaced with efficient encodes."
      };
    })
  };
}

async function downloadVolumeByIndexer(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, indexers: bytesBy(dataset.history, (event) => event.indexer, (event) => event.size ?? 0) })) };
}

async function historyDistribution(args: AnalyticsArgs, config: RuntimeConfig, field: "indexer", eventFilter: string): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => ({
      app: dataset.app,
      distribution: countBy(dataset.history.filter((event) => event.eventType.toLowerCase().includes(eventFilter)), (event) => event[field])
    }))
  };
}

async function successRate(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, indexers: successRateByIndexer(dataset.history) })) };
}

async function averageReleaseSize(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return { apps: datasets.map((dataset) => ({ app: dataset.app, averageBytes: averageSize(dataset.history), samples: dataset.history.filter((event) => (event.size ?? 0) > 0).length })) };
}

async function historyMatrix(args: AnalyticsArgs, config: RuntimeConfig, field: string): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => ({
      app: dataset.app,
      indexers: countBy(dataset.history, (event) => event.indexer).map((indexer) => ({
        indexer: indexer.value,
        count: indexer.count,
        values: countBy(dataset.history.filter((event) => (event.indexer ?? "unknown") === indexer.value), (event) => valueFromEvent(event as unknown, field)).slice(0, 10)
      }))
    }))
  };
}

async function duplicateGrabs(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => {
      const grabEvents = dataset.history.filter((event) => event.eventType.toLowerCase().includes("grab"));
      const duplicates = countBy(grabEvents, (event) => event.downloadId ?? event.title).filter((entry) => entry.count > 1 && entry.value !== "unknown");
      return { app: dataset.app, duplicates };
    })
  };
}

async function wastedDownloads(args: AnalyticsArgs, config: RuntimeConfig): Promise<unknown> {
  const datasets = await readDatasets(config, args.app);
  return {
    apps: datasets.map((dataset) => {
      const failed = dataset.history.filter((event) => event.eventType.toLowerCase().includes("fail"));
      return {
        app: dataset.app,
        failedEvents: failed.length,
        failedBytes: failed.reduce((total, event) => total + (event.size ?? 0), 0),
        byIndexer: bytesBy(failed, (event) => event.indexer, (event) => event.size ?? 0)
      };
    })
  };
}

function withProfileNames(dataset: Awaited<ReturnType<typeof readDatasets>>[number]): Array<{ value: string; count: number; profileId?: number }> {
  const names = profileNameById(dataset.qualityProfiles);
  return countBy(dataset.library, (item) => item.qualityProfileId).map((entry) => {
    const profileId = Number(entry.value);
    return Number.isFinite(profileId)
      ? { ...entry, value: names.get(profileId) ?? entry.value, profileId }
      : { ...entry, value: names.get(profileId) ?? entry.value };
  });
}

function valueFromEvent(event: unknown, field: string): string | number | undefined {
  return field.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, event) as string | number | undefined;
}
