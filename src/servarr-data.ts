import { clientFor } from "./client.js";
import { configuredApps } from "./config.js";
import { frequency, sumByPath } from "./response.js";
import type { AppName, RuntimeConfig } from "./types.js";

type RecordValue = Record<string, unknown>;

export interface LibraryItem {
  app: AppName;
  itemType: "movie" | "series" | "indexer";
  id?: number | string | undefined;
  title: string;
  monitored?: boolean | undefined;
  qualityProfileId?: number | undefined;
  rootFolderPath?: string | undefined;
  added?: string | undefined;
  sizeOnDisk: number;
  hasFile?: boolean | undefined;
  quality?: string | undefined;
  qualityResolution?: number | undefined;
  codec?: string | undefined;
  audioCodec?: string | undefined;
  hdr?: string | undefined;
  releaseGroup?: string | undefined;
  customFormats: string[];
  customFormatScore?: number | undefined;
  raw: unknown;
}

export interface HistoryEvent {
  app: AppName;
  id?: number | string | undefined;
  eventType: string;
  date?: string | undefined;
  indexer?: string | undefined;
  downloadClient?: string | undefined;
  title?: string | undefined;
  quality?: string | undefined;
  qualityResolution?: number | undefined;
  size?: number | undefined;
  releaseGroup?: string | undefined;
  language?: string | undefined;
  downloadId?: string | undefined;
  raw: unknown;
}

export interface QualityProfileSummary {
  app: AppName;
  id?: number | undefined;
  name: string;
  cutoff?: string | undefined;
  cutoffId?: number | undefined;
  qualities: string[];
  raw: unknown;
}

export interface CustomFormatSummary {
  app: AppName;
  id?: number | undefined;
  name: string;
  specificationCount: number;
  raw: unknown;
}

export interface ServarrDataset {
  app: AppName;
  library: LibraryItem[];
  history: HistoryEvent[];
  qualityProfiles: QualityProfileSummary[];
  customFormats: CustomFormatSummary[];
  cutoffUnmet: unknown[];
  queue: unknown[];
  health: unknown[];
}

export async function readDatasets(config: RuntimeConfig, app?: AppName): Promise<ServarrDataset[]> {
  const apps = app ? [app] : configuredApps(config);
  return Promise.all(apps.map((name) => readDataset(config, name)));
}

export async function readDataset(config: RuntimeConfig, app: AppName): Promise<ServarrDataset> {
  const client = clientFor(config, app);
  const [libraryRaw, historyRaw, qualityProfilesRaw, customFormatsRaw, cutoffUnmetRaw, queueRaw, healthRaw] = await Promise.all([
    readLibraryRaw(config, app),
    client.request("history", { query: { page: 1, pageSize: 500, sortKey: "date", sortDirection: "descending" } }).catch(() => []),
    client.request("qualityprofile").catch(() => []),
    client.request("customformat").catch(() => []),
    app === "prowlarr" ? Promise.resolve([]) : client.request("wanted/cutoff", { query: { page: 1, pageSize: 500 } }).catch(() => []),
    app === "prowlarr" ? Promise.resolve([]) : client.request("queue", { query: { page: 1, pageSize: 500 } }).catch(() => []),
    client.request("health").catch(() => [])
  ]);

  return {
    app,
    library: extractArray(libraryRaw).map((item) => normalizeLibraryItem(app, item)),
    history: extractArray(historyRaw).map((item) => normalizeHistoryEvent(app, item)),
    qualityProfiles: extractArray(qualityProfilesRaw).map((item) => normalizeQualityProfile(app, item)),
    customFormats: extractArray(customFormatsRaw).map((item) => normalizeCustomFormat(app, item)),
    cutoffUnmet: extractArray(cutoffUnmetRaw),
    queue: extractArray(queueRaw),
    health: extractArray(healthRaw)
  };
}

export async function readLibraryRaw(config: RuntimeConfig, app: AppName): Promise<unknown> {
  if (app === "radarr") {
    return clientFor(config, app).request("movie");
  }
  if (app === "sonarr") {
    return clientFor(config, app).request("series");
  }
  return clientFor(config, app).request("indexer");
}

export function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as RecordValue;
    for (const key of ["records", "items", "results"]) {
      if (Array.isArray(record[key])) {
        return record[key] as unknown[];
      }
    }
  }
  return [];
}

export function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as RecordValue)[part];
    }
    return undefined;
  }, value);
}

export function firstString(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const raw = valueAt(value, path);
    if (typeof raw === "string" && raw.trim()) {
      return raw;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return String(raw);
    }
  }
  return undefined;
}

export function firstNumber(value: unknown, paths: string[]): number | undefined {
  for (const path of paths) {
    const raw = valueAt(value, path);
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
  }
  return undefined;
}

export function countBy<T>(items: T[], getKey: (item: T) => string | number | undefined): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    const value = key === undefined || key === "" ? "unknown" : String(key);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function bytesBy<T>(items: T[], getKey: (item: T) => string | number | undefined, getBytes: (item: T) => number): Array<{ value: string; bytes: number; count: number }> {
  const groups = new Map<string, { bytes: number; count: number }>();
  for (const item of items) {
    const key = getKey(item);
    const value = key === undefined || key === "" ? "unknown" : String(key);
    const current = groups.get(value) ?? { bytes: 0, count: 0 };
    current.bytes += getBytes(item);
    current.count += 1;
    groups.set(value, current);
  }
  return [...groups.entries()]
    .map(([value, stats]) => ({ value, ...stats }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count || a.value.localeCompare(b.value));
}

export function totalStorageBytes(items: LibraryItem[]): number {
  return items.reduce((total, item) => total + item.sizeOnDisk, 0);
}

export function duplicateValues(values: string[]): Array<{ value: string; count: number }> {
  return countBy(values.map((value) => ({ value })), (item) => item.value).filter((item) => item.count > 1);
}

export function groupHistoryByMonth(events: HistoryEvent[]): Array<{ month: string; events: number; grabs: number; imports: number; failures: number; bytes: number }> {
  const months = new Map<string, { events: number; grabs: number; imports: number; failures: number; bytes: number }>();
  for (const event of events) {
    const month = event.date ? event.date.slice(0, 7) : "unknown";
    const current = months.get(month) ?? { events: 0, grabs: 0, imports: 0, failures: 0, bytes: 0 };
    current.events += 1;
    current.bytes += event.size ?? 0;
    if (event.eventType.toLowerCase().includes("grab")) {
      current.grabs += 1;
    }
    if (event.eventType.toLowerCase().includes("import")) {
      current.imports += 1;
    }
    if (event.eventType.toLowerCase().includes("fail")) {
      current.failures += 1;
    }
    months.set(month, current);
  }
  return [...months.entries()].map(([month, stats]) => ({ month, ...stats })).sort((a, b) => b.month.localeCompare(a.month));
}

export function successRateByIndexer(events: HistoryEvent[]): Array<{ indexer: string; grabs: number; imports: number; failures: number; successRate: number }> {
  const groups = new Map<string, { grabs: number; imports: number; failures: number }>();
  for (const event of events) {
    const indexer = event.indexer ?? "unknown";
    const current = groups.get(indexer) ?? { grabs: 0, imports: 0, failures: 0 };
    const eventType = event.eventType.toLowerCase();
    if (eventType.includes("grab")) {
      current.grabs += 1;
    }
    if (eventType.includes("import")) {
      current.imports += 1;
    }
    if (eventType.includes("fail")) {
      current.failures += 1;
    }
    groups.set(indexer, current);
  }
  return [...groups.entries()]
    .map(([indexer, stats]) => ({
      indexer,
      ...stats,
      successRate: stats.grabs > 0 ? Number(((stats.imports / stats.grabs) * 100).toFixed(2)) : 0
    }))
    .sort((a, b) => b.grabs - a.grabs || a.indexer.localeCompare(b.indexer));
}

export function averageSize(events: HistoryEvent[]): number {
  const sized = events.filter((event) => typeof event.size === "number" && event.size > 0);
  if (sized.length === 0) {
    return 0;
  }
  return Math.round(sized.reduce((total, event) => total + (event.size ?? 0), 0) / sized.length);
}

export function profileNameById(profiles: QualityProfileSummary[]): Map<number, string> {
  const result = new Map<number, string>();
  for (const profile of profiles) {
    if (profile.id !== undefined) {
      result.set(profile.id, profile.name);
    }
  }
  return result;
}

export function legacyFrequency(items: unknown[], path: string): Array<{ value: string; count: number }> {
  return frequency(items, path);
}

export function legacyStorageBytes(items: unknown[]): number {
  return sumByPath(items, "movieFile.size") + sumByPath(items, "episodeFile.size") + sumByPath(items, "statistics.sizeOnDisk") + sumByPath(items, "size");
}

function normalizeLibraryItem(app: AppName, item: unknown): LibraryItem {
  const record = item && typeof item === "object" ? (item as RecordValue) : {};
  const file = (record.movieFile ?? record.episodeFile) as unknown;
  const stats = record.statistics as unknown;
  const title = firstString(item, ["title", "sortTitle", "name"]) ?? "unknown";
  const customFormats = extractCustomFormatNames(file).concat(extractCustomFormatNames(item));
  const sizeOnDisk =
    firstNumber(file, ["size"]) ??
    firstNumber(stats, ["sizeOnDisk", "episodeFileCount"]) ??
    firstNumber(item, ["sizeOnDisk"]) ??
    0;

  return {
    app,
    itemType: app === "radarr" ? "movie" : app === "sonarr" ? "series" : "indexer",
    id: typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined,
    title,
    monitored: typeof record.monitored === "boolean" ? record.monitored : undefined,
    qualityProfileId: firstNumber(item, ["qualityProfileId"]),
    rootFolderPath: firstString(item, ["rootFolderPath", "path"]),
    added: firstString(item, ["added", "dateAdded"]),
    sizeOnDisk,
    hasFile: typeof record.hasFile === "boolean" ? record.hasFile : undefined,
    quality: firstString(item, ["movieFile.quality.quality.name", "episodeFile.quality.quality.name", "quality.quality.name"]),
    qualityResolution: firstNumber(item, ["movieFile.quality.quality.resolution", "episodeFile.quality.quality.resolution", "quality.quality.resolution"]),
    codec: firstString(item, ["movieFile.mediaInfo.videoCodec", "episodeFile.mediaInfo.videoCodec", "mediaInfo.videoCodec"]),
    audioCodec: firstString(item, ["movieFile.mediaInfo.audioCodec", "episodeFile.mediaInfo.audioCodec", "mediaInfo.audioCodec"]),
    hdr: firstString(item, ["movieFile.mediaInfo.videoDynamicRange", "episodeFile.mediaInfo.videoDynamicRange", "mediaInfo.videoDynamicRange"]),
    releaseGroup: firstString(item, ["movieFile.releaseGroup", "episodeFile.releaseGroup", "releaseGroup"]),
    customFormats: [...new Set(customFormats)],
    customFormatScore: firstNumber(item, ["movieFile.customFormatScore", "episodeFile.customFormatScore", "customFormatScore"]),
    raw: item
  };
}

function normalizeHistoryEvent(app: AppName, item: unknown): HistoryEvent {
  const record = item && typeof item === "object" ? (item as RecordValue) : {};
  return {
    app,
    id: typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined,
    eventType: firstString(item, ["eventType"]) ?? "unknown",
    date: firstString(item, ["date"]),
    indexer: firstString(item, ["indexer", "data.indexer", "data.indexerName"]),
    downloadClient: firstString(item, ["downloadClient", "data.downloadClient", "data.downloadClientName"]),
    title: firstString(item, ["sourceTitle", "movie.title", "series.title", "title"]),
    quality: firstString(item, ["quality.quality.name", "data.quality", "data.qualityName"]),
    qualityResolution: firstNumber(item, ["quality.quality.resolution"]),
    size: firstNumber(item, ["data.size", "size"]),
    releaseGroup: firstString(item, ["releaseGroup", "data.releaseGroup"]),
    language: firstString(item, ["language.name", "languages.0.name", "data.language"]),
    downloadId: firstString(item, ["downloadId", "data.downloadId"]),
    raw: item
  };
}

function normalizeQualityProfile(app: AppName, item: unknown): QualityProfileSummary {
  return {
    app,
    id: firstNumber(item, ["id"]),
    name: firstString(item, ["name"]) ?? "unknown",
    cutoff: firstString(item, ["cutoff.name"]),
    cutoffId: firstNumber(item, ["cutoff.id", "cutoff"]),
    qualities: extractProfileQualityNames(item),
    raw: item
  };
}

function normalizeCustomFormat(app: AppName, item: unknown): CustomFormatSummary {
  const specs = valueAt(item, "specifications");
  return {
    app,
    id: firstNumber(item, ["id"]),
    name: firstString(item, ["name"]) ?? "unknown",
    specificationCount: Array.isArray(specs) ? specs.length : 0,
    raw: item
  };
}

function extractCustomFormatNames(item: unknown): string[] {
  const formats = valueAt(item, "customFormats");
  if (!Array.isArray(formats)) {
    return [];
  }
  return formats
    .map((format) => firstString(format, ["name"]))
    .filter((name): name is string => Boolean(name));
}

function extractProfileQualityNames(item: unknown): string[] {
  const items = valueAt(item, "items");
  if (!Array.isArray(items)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of items) {
    const qualityName = firstString(entry, ["quality.name"]);
    if (qualityName) {
      names.push(qualityName);
    }
    const nested = valueAt(entry, "items");
    if (Array.isArray(nested)) {
      for (const child of nested) {
        const childName = firstString(child, ["quality.name"]);
        if (childName) {
          names.push(childName);
        }
      }
    }
  }
  return [...new Set(names)];
}
