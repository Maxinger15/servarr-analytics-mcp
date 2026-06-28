import * as z from "zod/v4";
import { clientFor } from "./client.js";
import { configuredApps } from "./config.js";
import { frequency, shapeResult, sumByPath } from "./response.js";
import { optionalAppOptionsSchema } from "./schemas.js";
import type { AppName, CommonQueryOptions, RuntimeConfig, ToolDefinition } from "./types.js";

type AnyRecord = Record<string, unknown>;

const distributionPaths: Record<string, string[]> = {
  codec: ["movieFile.mediaInfo.videoCodec", "episodeFile.mediaInfo.videoCodec", "mediaInfo.videoCodec"],
  resolution: ["movieFile.quality.quality.resolution", "episodeFile.quality.quality.resolution", "quality.quality.resolution"],
  hdr: ["movieFile.mediaInfo.videoDynamicRange", "episodeFile.mediaInfo.videoDynamicRange", "mediaInfo.videoDynamicRange"],
  audio: ["movieFile.mediaInfo.audioCodec", "episodeFile.mediaInfo.audioCodec", "mediaInfo.audioCodec"],
  quality: ["movieFile.quality.quality.name", "episodeFile.quality.quality.name", "quality.quality.name"],
  profile: ["qualityProfileId", "profileId"],
  releaseGroup: ["releaseGroup", "customFormatScore"],
  language: ["language.name", "languages.0.name"]
};

function getPathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as AnyRecord)[part];
    }
    return undefined;
  }, value);
}

function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as AnyRecord;
    for (const key of ["records", "items", "results"]) {
      if (Array.isArray(record[key])) {
        return record[key] as unknown[];
      }
    }
  }
  return [];
}

async function readLibrary(config: RuntimeConfig, app: AppName): Promise<unknown[]> {
  if (app === "radarr") {
    return extractArray(await clientFor(config, "radarr").request("movie"));
  }
  if (app === "sonarr") {
    return extractArray(await clientFor(config, "sonarr").request("series"));
  }
  return extractArray(await clientFor(config, "prowlarr").request("indexer"));
}

async function readHistory(config: RuntimeConfig, app: AppName): Promise<unknown[]> {
  return extractArray(await clientFor(config, app).request("history", { query: { page: 1, pageSize: 500, sortKey: "date", sortDirection: "descending" } }));
}

async function readApps(config: RuntimeConfig, requested?: AppName): Promise<AppName[]> {
  return requested ? [requested] : configuredApps(config);
}

function firstDistribution(items: unknown[], keys: string[]): Array<{ value: string; count: number }> {
  const expanded = items.map((item) => {
    for (const key of keys) {
      const value = getPathValue(item, key);
      if (value !== undefined && value !== null && value !== "") {
        return { value };
      }
    }
    return { value: "unknown" };
  });
  return frequency(expanded, "value");
}

function storageBytes(items: unknown[]): number {
  return (
    sumByPath(items, "movieFile.size") +
    sumByPath(items, "episodeFile.size") +
    sumByPath(items, "size") +
    sumByPath(items, "statistics.sizeOnDisk")
  );
}

async function librarySummary(config: RuntimeConfig, app?: AppName): Promise<unknown> {
  const apps = await readApps(config, app);
  const summaries = await Promise.all(
    apps.map(async (name) => {
      const library = await readLibrary(config, name);
      return {
        app: name,
        items: library.length,
        storageBytes: storageBytes(library),
        qualityDistribution: firstDistribution(library, distributionPaths.quality).slice(0, 10),
        codecDistribution: firstDistribution(library, distributionPaths.codec).slice(0, 10),
        profileUsage: firstDistribution(library, distributionPaths.profile).slice(0, 10)
      };
    })
  );
  return { apps: summaries };
}

async function distribution(config: RuntimeConfig, app: AppName | undefined, kind: keyof typeof distributionPaths): Promise<unknown> {
  const apps = await readApps(config, app);
  const results = await Promise.all(
    apps.map(async (name) => {
      const library = await readLibrary(config, name);
      return { app: name, distribution: firstDistribution(library, distributionPaths[kind]) };
    })
  );
  return { kind, apps: results };
}

async function storageDistribution(config: RuntimeConfig, app: AppName | undefined, kind?: keyof typeof distributionPaths): Promise<unknown> {
  const apps = await readApps(config, app);
  const results = await Promise.all(
    apps.map(async (name) => {
      const library = await readLibrary(config, name);
      return {
        app: name,
        totalBytes: storageBytes(library),
        groupedBy: kind,
        distribution: kind ? firstDistribution(library, distributionPaths[kind]).slice(0, 25) : undefined
      };
    })
  );
  return { apps: results };
}

async function historyDistribution(config: RuntimeConfig, app: AppName | undefined, field: string): Promise<unknown> {
  const apps = await readApps(config, app);
  const results = await Promise.all(
    apps.map(async (name) => {
      const history = await readHistory(config, name);
      return { app: name, distribution: frequency(history, field).slice(0, 25), samples: history.slice(0, 5) };
    })
  );
  return { apps: results };
}

function analyticsTool(name: string, title: string, description: string, run: (args: z.infer<typeof optionalAppOptionsSchema>, config: RuntimeConfig) => Promise<unknown>): ToolDefinition {
  return {
    name,
    title,
    description,
    inputSchema: optionalAppOptionsSchema,
    async handler(args: z.infer<typeof optionalAppOptionsSchema>, context) {
      const data = await run(args, context.config);
      return shapeResult(data, args as CommonQueryOptions, { tool: name });
    }
  };
}

const qualityToolNames = [
  "quality_profile_usage",
  "quality_distribution",
  "codec_distribution",
  "resolution_distribution",
  "hdr_distribution",
  "audio_distribution",
  "cutoff_unmet_by_profile",
  "upgrade_candidates",
  "profile_overlap",
  "redundant_quality_profiles"
] as const;

const customFormatToolNames = [
  "custom_format_hits",
  "custom_format_misses",
  "unused_custom_formats",
  "duplicate_custom_formats",
  "conflicting_custom_formats"
] as const;

const trackerToolNames = [
  "download_volume_by_indexer",
  "grabs_by_indexer",
  "imports_by_indexer",
  "failed_downloads_by_indexer",
  "success_rate_by_indexer",
  "average_release_size",
  "quality_by_indexer",
  "codec_by_indexer",
  "language_by_indexer",
  "release_group_by_indexer",
  "duplicate_grabs",
  "wasted_downloads"
] as const;

export function createAnalyticsTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    analyticsTool("library_summary", "Library Summary", "Summarize configured Servarr libraries.", (args, config) => librarySummary(config, args.app)),
    analyticsTool("library_storage_stats", "Library Storage Stats", "Summarize storage usage by library.", (args, config) => storageDistribution(config, args.app)),
    analyticsTool("library_codec_distribution", "Library Codec Distribution", "Summarize video codec distribution.", (args, config) => distribution(config, args.app, "codec")),
    analyticsTool("library_resolution_distribution", "Library Resolution Distribution", "Summarize resolution distribution.", (args, config) => distribution(config, args.app, "resolution")),
    analyticsTool("library_hdr_distribution", "Library HDR Distribution", "Summarize HDR/dynamic range distribution.", (args, config) => distribution(config, args.app, "hdr")),
    analyticsTool("library_audio_distribution", "Library Audio Distribution", "Summarize audio codec distribution.", (args, config) => distribution(config, args.app, "audio")),
    analyticsTool("library_quality_distribution", "Library Quality Distribution", "Summarize quality distribution.", (args, config) => distribution(config, args.app, "quality")),
    analyticsTool("library_profile_usage", "Library Profile Usage", "Summarize quality profile usage.", (args, config) => distribution(config, args.app, "profile")),
    analyticsTool("library_growth_statistics", "Library Growth Statistics", "Estimate growth from recently added records.", (args, config) => historyDistribution(config, args.app, "date")),
    analyticsTool("storage_usage", "Storage Usage", "Summarize storage usage.", (args, config) => storageDistribution(config, args.app)),
    analyticsTool("storage_by_codec", "Storage By Codec", "Group storage by codec.", (args, config) => storageDistribution(config, args.app, "codec")),
    analyticsTool("storage_by_quality", "Storage By Quality", "Group storage by quality.", (args, config) => storageDistribution(config, args.app, "quality")),
    analyticsTool("storage_by_resolution", "Storage By Resolution", "Group storage by resolution.", (args, config) => storageDistribution(config, args.app, "resolution")),
    analyticsTool("storage_growth", "Storage Growth", "Estimate storage growth from history.", (args, config) => historyDistribution(config, args.app, "date")),
    analyticsTool("estimated_storage_savings", "Estimated Storage Savings", "Estimate potential savings from lower-bitrate or cutoff strategies.", (args, config) => storageDistribution(config, args.app, "codec"))
  ];

  for (const name of qualityToolNames) {
    tools.push(analyticsTool(name, titleFromName(name), `Analyze ${name.replaceAll("_", " ")}.`, (args, config) => distribution(config, args.app, qualityKind(name))));
  }

  for (const name of customFormatToolNames) {
    tools.push(analyticsTool(name, titleFromName(name), `Analyze ${name.replaceAll("_", " ")}.`, async (args, config) => {
      const apps = await readApps(config, args.app);
      const results = await Promise.all(apps.map(async (app) => ({ app, customFormats: extractArray(await clientFor(config, app).request("customformat")) })));
      return { analysis: name, apps: results };
    }));
  }

  for (const name of trackerToolNames) {
    tools.push(analyticsTool(name, titleFromName(name), `Analyze ${name.replaceAll("_", " ")}.`, (args, config) => historyDistribution(config, args.app, trackerField(name))));
  }

  return tools;
}

function titleFromName(name: string): string {
  return name.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function qualityKind(name: string): keyof typeof distributionPaths {
  if (name.includes("codec")) {
    return "codec";
  }
  if (name.includes("resolution")) {
    return "resolution";
  }
  if (name.includes("hdr")) {
    return "hdr";
  }
  if (name.includes("audio")) {
    return "audio";
  }
  if (name.includes("profile")) {
    return "profile";
  }
  return "quality";
}

function trackerField(name: string): string {
  if (name.includes("quality")) {
    return "quality.quality.name";
  }
  if (name.includes("codec")) {
    return "data.videoCodec";
  }
  if (name.includes("language")) {
    return "languages.0.name";
  }
  if (name.includes("release_group")) {
    return "releaseGroup";
  }
  return "indexer";
}
