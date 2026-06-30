import * as z from "zod/v4";
import { clientFor } from "./client.js";
import { shapeResult } from "./response.js";
import { appOptionsSchema } from "./schemas.js";
import {
  extractArray,
  firstNumber,
  firstString,
  profileNameById,
  readDataset,
  valueAt
} from "./servarr-data.js";
import type { CustomFormatSummary, MediaFileItem, QualityProfileSummary } from "./servarr-data.js";
import type { CommonQueryOptions, RuntimeConfig, ToolDefinition } from "./types.js";

type JsonRecord = Record<string, unknown>;

type ProfileImpactArgs = z.infer<typeof profileImpactSchema>;

interface ParsedQuality {
  id?: number | undefined;
  name: string;
}

interface ParsedQualityProfile {
  id?: number | undefined;
  name: string;
  qualities: ParsedQuality[];
  allowedQualities: Set<string>;
  qualityRank: Map<string, number>;
  cutoff?: string | undefined;
  cutoffRank?: number | undefined;
  minFormatScore: number;
  formatScoresById: Map<number, number>;
  formatScoresByName: Map<string, number>;
}

interface ParsedCustomFormat {
  id?: number | undefined;
  name: string;
  specifications: CustomFormatSpecification[];
  unsupportedSpecifications: string[];
}

interface CustomFormatSpecification {
  label: string;
  negate: boolean;
  required: boolean;
  match: (candidate: MatchCandidate) => boolean | undefined;
}

interface MatchCandidate {
  title: string;
  quality?: string | undefined;
  qualityResolution?: number | undefined;
  languages: string[];
  releaseGroup?: string | undefined;
  indexer?: string | undefined;
  customFormats: string[];
}

interface ImpactTarget {
  app: "sonarr" | "radarr";
  itemType: "movie" | "episode";
  id: number;
  parentId?: number | undefined;
  title: string;
  qualityProfileId?: number | undefined;
  currentFile?: MediaFileItem | undefined;
  raw: unknown;
}

interface ReleaseCandidate extends MatchCandidate {
  raw: unknown;
  size?: number | undefined;
}

interface Evaluation {
  accepted: boolean;
  qualityAllowed: boolean;
  meetsCutoff: boolean;
  score: number;
  matchedCustomFormats: string[];
  rejectionReasons: string[];
  unsupportedSpecifications: Array<{ customFormat: string; specifications: string[] }>;
}

const MEDIA_APPS = ["sonarr", "radarr"] as const;

const profileMappingSchema = z.record(z.string(), z.unknown());

const profileImpactSchema = appOptionsSchema.extend({
  app: z.enum(MEDIA_APPS),
  qualityProfiles: z.array(z.record(z.string(), z.unknown())).min(1),
  customFormats: z.array(z.record(z.string(), z.unknown())).optional(),
  profileMappings: z.array(profileMappingSchema).optional(),
  search: z.object({
    concurrency: z.number().int().positive().max(6).optional(),
    batchSize: z.number().int().positive().max(500).optional(),
    cursor: z.string().optional(),
    includeUnsupportedCustomFormatSpecs: z.boolean().optional()
  }).optional()
});

export function createProfileImpactTools(): ToolDefinition[] {
  return [
    {
      name: "simulate_profile_impact",
      title: "Simulate Profile Impact",
      description: "Dry-run hypothetical quality profiles and custom formats against current files and live releases without applying changes.",
      inputSchema: profileImpactSchema,
      async handler(args, context) {
        return shapeResult(await simulateProfileImpact(args, context.config), args as CommonQueryOptions, { tool: "simulate_profile_impact" });
      }
    }
  ];
}

async function simulateProfileImpact(args: ProfileImpactArgs, config: RuntimeConfig): Promise<unknown> {
  const app = args.app;
  const dataset = await readDataset(config, app, { includeMediaFiles: true });
  const configuredFormatNames = formatNameMaps(dataset.customFormats, args.customFormats ?? []);
  const profiles = args.qualityProfiles.map((profile) => parseQualityProfile(profile, configuredFormatNames.byId));
  const customFormats = (args.customFormats ?? []).map(parseCustomFormat);
  const profileNames = profileNameById(dataset.qualityProfiles);
  const targets = await readImpactTargets(config, app, dataset.library.map((item) => item.raw), dataset.mediaFiles);
  const { start, batchSize } = decodeSearchWindow(args.search?.cursor, args.search?.batchSize ?? 50);
  const selectedTargets = targets.slice(start, start + batchSize);
  const nextOffset = start + selectedTargets.length;
  const concurrency = args.search?.concurrency ?? 2;
  const profileByTarget = (target: ImpactTarget) => resolveProfile(target, profiles, dataset.qualityProfiles, profileNames, args.profileMappings);
  const currentFileImpacts = targets.map((target) => {
    const currentProfile = dataset.qualityProfiles.find((profile) => profile.id === target.qualityProfileId);
    return evaluateCurrentFile(target, profileByTarget(target), currentProfile, configuredFormatNames.byId, customFormats, args.search?.includeUnsupportedCustomFormatSpecs ?? false);
  });
  const releaseResults = await mapWithConcurrency(selectedTargets, concurrency, async (target) => {
    const profile = profileByTarget(target);
    return evaluateTargetReleases(config, target, profile, customFormats, args.search?.includeUnsupportedCustomFormatSpecs ?? false);
  });
  const liveReleaseImpacts = releaseResults.flatMap((result) => result.releases);
  const searchErrors = releaseResults.flatMap((result) => result.errors);

  return {
    simulation: "simulate_profile_impact",
    dryRun: true,
    app,
    search: {
      mode: "whole-library",
      batchStart: start,
      batchSize,
      searchedItems: selectedTargets.length,
      totalItems: targets.length,
      nextCursor: nextOffset < targets.length ? encodeCursor(nextOffset) : undefined,
      concurrency
    },
    summary: {
      currentFiles: summarize(currentFileImpacts, "status"),
      currentFileChanges: summarizeChanges(currentFileImpacts),
      liveReleases: summarize(liveReleaseImpacts, "status"),
      searchErrors: searchErrors.length,
      unsupportedCustomFormats: customFormats.filter((format) => format.unsupportedSpecifications.length > 0).map((format) => ({
        customFormat: format.name,
        specifications: format.unsupportedSpecifications
      }))
    },
    currentFileImpacts,
    liveReleaseImpacts,
    searchErrors,
    notes: [
      "Dry run only. This tool uses read-only Servarr GET endpoints and never grabs, imports, creates, updates, or deletes records.",
      "Existing Servarr customFormat matches are treated as exact; newly supplied custom format definitions are matched locally on a best-effort basis."
    ]
  };
}

export function parseQualityProfile(rawProfile: JsonRecord, customFormatNamesById: Map<number, string> = new Map()): ParsedQualityProfile {
  const name = firstString(rawProfile, ["name"]) ?? "unknown";
  const id = firstNumber(rawProfile, ["id"]);
  const qualities = extractProfileQualities(rawProfile);
  const allowedQualities = new Set(qualities.map((quality) => quality.name));
  const qualityRank = new Map(qualities.map((quality, index) => [quality.name, index]));
  const cutoff = cutoffName(rawProfile, qualities);
  const cutoffRank = cutoff ? qualityRank.get(cutoff) : undefined;
  const formatScores = extractFormatScores(rawProfile, customFormatNamesById);

  return {
    ...(id === undefined ? {} : { id }),
    name,
    qualities,
    allowedQualities,
    qualityRank,
    ...(cutoff === undefined ? {} : { cutoff }),
    ...(cutoffRank === undefined ? {} : { cutoffRank }),
    minFormatScore: firstNumber(rawProfile, ["minFormatScore", "minimumFormatScore"]) ?? 0,
    formatScoresById: formatScores.byId,
    formatScoresByName: formatScores.byName
  };
}

export function parseCustomFormat(rawFormat: JsonRecord): ParsedCustomFormat {
  const id = firstNumber(rawFormat, ["id"]);
  const name = firstString(rawFormat, ["name"]) ?? "unknown";
  const rawSpecifications = valueAt(rawFormat, "specifications");
  const specifications: CustomFormatSpecification[] = [];
  const unsupportedSpecifications: string[] = [];

  if (Array.isArray(rawSpecifications)) {
    for (const rawSpec of rawSpecifications) {
      const parsed = parseCustomFormatSpecification(rawSpec);
      if (parsed) {
        specifications.push(parsed);
      } else {
        unsupportedSpecifications.push(specificationLabel(rawSpec));
      }
    }
  }

  return {
    ...(id === undefined ? {} : { id }),
    name,
    specifications,
    unsupportedSpecifications
  };
}

export function matchCustomFormats(candidate: MatchCandidate, formats: ParsedCustomFormat[]): Array<{ name: string; unsupportedSpecifications: string[] }> {
  const matches: Array<{ name: string; unsupportedSpecifications: string[] }> = [];
  for (const format of formats) {
    if (format.specifications.length === 0) {
      continue;
    }
    let failedRequired = false;
    let matchedRequired = false;
    let matchedOptional = false;
    for (const specification of format.specifications) {
      const rawMatch = specification.match(candidate);
      const matched = specification.negate ? rawMatch === false : rawMatch === true;
      if (specification.required) {
        matchedRequired = matchedRequired || matched;
        if (!matched) {
          failedRequired = true;
          break;
        }
      } else {
        matchedOptional = matchedOptional || matched;
      }
    }
    if (!failedRequired && (matchedRequired || matchedOptional)) {
      matches.push({ name: format.name, unsupportedSpecifications: format.unsupportedSpecifications });
    }
  }
  return matches;
}

function extractProfileQualities(profile: JsonRecord): ParsedQuality[] {
  const items = valueAt(profile, "items");
  if (!Array.isArray(items)) {
    const rawQualities = valueAt(profile, "qualities");
    if (Array.isArray(rawQualities)) {
      return rawQualities
        .map((quality) => {
          const name = firstString(quality, ["name", "quality.name"]);
          return name ? withOptionalId(name, firstNumber(quality, ["id"])) : undefined;
        })
        .filter((quality): quality is ParsedQuality => quality !== undefined);
    }
    return [];
  }

  const qualities: ParsedQuality[] = [];
  for (const item of items) {
    const parentAllowed = valueAt(item, "allowed") !== false;
    const directName = firstString(item, ["quality.name"]);
    if (directName && parentAllowed) {
      qualities.push(withOptionalId(directName, firstNumber(item, ["quality.id", "id"])));
    }
    const children = valueAt(item, "items");
    if (!Array.isArray(children)) {
      continue;
    }
    for (const child of children) {
      if (!parentAllowed || valueAt(child, "allowed") === false) {
        continue;
      }
      const childName = firstString(child, ["quality.name"]);
      if (childName) {
        qualities.push(withOptionalId(childName, firstNumber(child, ["quality.id", "id"])));
      }
    }
  }

  const seen = new Set<string>();
  return qualities.filter((quality) => {
    if (seen.has(quality.name)) {
      return false;
    }
    seen.add(quality.name);
    return true;
  });
}

function withOptionalId(name: string, id: number | undefined): ParsedQuality {
  return id === undefined ? { name } : { id, name };
}

function cutoffName(profile: JsonRecord, qualities: ParsedQuality[]): string | undefined {
  const named = firstString(profile, ["cutoff.name", "cutoff"]);
  if (named && Number.isNaN(Number(named))) {
    return named;
  }
  const cutoffId = firstNumber(profile, ["cutoff.id", "cutoff"]);
  return cutoffId === undefined ? named : qualities.find((quality) => quality.id === cutoffId)?.name;
}

function extractFormatScores(profile: JsonRecord, customFormatNamesById: Map<number, string>): { byId: Map<number, number>; byName: Map<string, number> } {
  const byId = new Map<number, number>();
  const byName = new Map<string, number>();
  const formatItems = valueAt(profile, "formatItems");
  if (!Array.isArray(formatItems)) {
    return { byId, byName };
  }
  for (const item of formatItems) {
    const score = firstNumber(item, ["score"]) ?? 0;
    const formatId = firstNumber(item, ["format", "formatId", "id", "customFormatId"]);
    const name = firstString(item, ["name", "customFormat.name"]) ?? (formatId === undefined ? undefined : customFormatNamesById.get(formatId));
    if (formatId !== undefined) {
      byId.set(formatId, score);
    }
    if (name) {
      byName.set(name, score);
    }
  }
  return { byId, byName };
}

function parseCustomFormatSpecification(rawSpec: unknown): CustomFormatSpecification | undefined {
  const label = specificationLabel(rawSpec);
  const implementation = label.toLowerCase();
  const values = specificationValues(rawSpec);
  const negate = valueAt(rawSpec, "negate") === true;
  const required = valueAt(rawSpec, "required") !== false;

  if (implementation.includes("title") || implementation.includes("regex")) {
    const patterns = values.length > 0 ? values : [firstString(rawSpec, ["value", "pattern"])]
      .filter((value): value is string => Boolean(value));
    if (patterns.length === 0) {
      return undefined;
    }
    return {
      label,
      negate,
      required,
      match: (candidate) => patterns.some((pattern) => testPattern(pattern, candidate.title))
    };
  }

  if (implementation.includes("releasegroup") || implementation.includes("release group")) {
    return matcherForValues(label, negate, required, values, (candidate) => candidate.releaseGroup);
  }
  if (implementation.includes("indexer")) {
    return matcherForValues(label, negate, required, values, (candidate) => candidate.indexer);
  }
  if (implementation.includes("language")) {
    return matcherForValues(label, negate, required, values, (candidate) => candidate.languages.join(" "));
  }
  if (implementation.includes("resolution")) {
    const numbers = values.map(Number).filter(Number.isFinite);
    if (numbers.length === 0) {
      return undefined;
    }
    return {
      label,
      negate,
      required,
      match: (candidate) => candidate.qualityResolution === undefined ? undefined : numbers.includes(candidate.qualityResolution)
    };
  }
  if (implementation.includes("quality")) {
    return matcherForValues(label, negate, required, values, (candidate) => candidate.quality);
  }

  return undefined;
}

function matcherForValues(
  label: string,
  negate: boolean,
  required: boolean,
  values: string[],
  read: (candidate: MatchCandidate) => string | undefined
): CustomFormatSpecification | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return {
    label,
    negate,
    required,
    match: (candidate) => {
      const haystack = read(candidate)?.toLowerCase();
      if (!haystack) {
        return undefined;
      }
      return values.some((value) => haystack.includes(value.toLowerCase()));
    }
  };
}

function specificationLabel(rawSpec: unknown): string {
  return firstString(rawSpec, ["implementation", "name", "type"]) ?? "unknown";
}

function specificationValues(rawSpec: unknown): string[] {
  const fields = valueAt(rawSpec, "fields");
  const values: string[] = [];
  if (Array.isArray(fields)) {
    for (const field of fields) {
      const value = valueAt(field, "value");
      if (typeof value === "string" && value.trim()) {
        values.push(value);
      }
      if (Array.isArray(value)) {
        values.push(...value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0));
      }
    }
  }
  for (const path of ["value", "pattern", "regex", "term"]) {
    const value = firstString(rawSpec, [path]);
    if (value) {
      values.push(value);
    }
  }
  return [...new Set(values)];
}

function testPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}

function formatNameMaps(configuredFormats: CustomFormatSummary[], suppliedFormats: JsonRecord[]): { byId: Map<number, string>; byName: Map<string, string> } {
  const byId = new Map<number, string>();
  const byName = new Map<string, string>();
  for (const format of configuredFormats) {
    if (format.id !== undefined) {
      byId.set(format.id, format.name);
    }
    byName.set(format.name.toLowerCase(), format.name);
  }
  for (const format of suppliedFormats) {
    const id = firstNumber(format, ["id"]);
    const name = firstString(format, ["name"]);
    if (!name) {
      continue;
    }
    if (id !== undefined) {
      byId.set(id, name);
    }
    byName.set(name.toLowerCase(), name);
  }
  return { byId, byName };
}

async function readImpactTargets(config: RuntimeConfig, app: "sonarr" | "radarr", libraryRaw: unknown[], mediaFiles: MediaFileItem[]): Promise<ImpactTarget[]> {
  if (app === "radarr") {
    const targets: ImpactTarget[] = [];
    for (const movie of libraryRaw) {
      const id = firstNumber(movie, ["id"]);
      if (id === undefined) {
        continue;
      }
      const currentFile = mediaFiles.find((file) => file.movieId === id || file.parentId === id);
      const qualityProfileId = firstNumber(movie, ["qualityProfileId"]);
      targets.push({
        app,
        itemType: "movie",
        id,
        title: firstString(movie, ["title", "sortTitle"]) ?? `Movie ${id}`,
        ...(qualityProfileId === undefined ? {} : { qualityProfileId }),
        ...(currentFile === undefined ? {} : { currentFile }),
        raw: movie
      });
    }
    return targets;
  }

  const client = clientFor(config, app);
  const fileById = new Map<number, MediaFileItem>();
  for (const file of mediaFiles) {
    const id = Number(file.id);
    if (Number.isFinite(id)) {
      fileById.set(id, file);
    }
  }
  const episodeGroups = await mapWithConcurrency(libraryRaw, 4, async (series) => {
    const seriesId = firstNumber(series, ["id"]);
    if (seriesId === undefined) {
      return [];
    }
    const response = await client.request("episode", { query: { seriesId } }).catch(() => []);
    const targets: ImpactTarget[] = [];
    for (const episode of extractArray(response)) {
      const episodeId = firstNumber(episode, ["id"]);
      if (episodeId === undefined) {
        continue;
      }
      const fileId = firstNumber(episode, ["episodeFileId", "episodeFile.id"]);
      const currentFile = fileId === undefined ? undefined : fileById.get(fileId);
      const qualityProfileId = firstNumber(series, ["qualityProfileId"]);
      targets.push({
        app,
        itemType: "episode",
        id: episodeId,
        parentId: seriesId,
        title: episodeTitle(series, episode),
        ...(qualityProfileId === undefined ? {} : { qualityProfileId }),
        ...(currentFile === undefined ? {} : { currentFile }),
        raw: episode
      });
    }
    return targets;
  });
  return episodeGroups.flat();
}

function episodeTitle(series: unknown, episode: unknown): string {
  const seriesTitle = firstString(series, ["title", "sortTitle"]) ?? "Series";
  const season = firstNumber(episode, ["seasonNumber"]);
  const episodeNumber = firstNumber(episode, ["episodeNumber"]);
  const episodeName = firstString(episode, ["title"]);
  const number = season !== undefined && episodeNumber !== undefined ? ` S${String(season).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}` : "";
  return `${seriesTitle}${number}${episodeName ? ` - ${episodeName}` : ""}`;
}

function resolveProfile(
  target: ImpactTarget,
  profiles: ParsedQualityProfile[],
  currentProfiles: QualityProfileSummary[],
  profileNames: Map<number, string>,
  mappings: JsonRecord[] | undefined
): ParsedQualityProfile | undefined {
  const currentName = target.qualityProfileId === undefined ? undefined : profileNames.get(target.qualityProfileId);
  const mapped = mappings?.find((mapping) => {
    const sourceId = firstNumber(mapping, ["sourceQualityProfileId", "qualityProfileId", "sourceProfileId"]);
    const sourceName = firstString(mapping, ["sourceQualityProfileName", "qualityProfileName", "sourceProfileName"]);
    return (sourceId !== undefined && sourceId === target.qualityProfileId) || (sourceName !== undefined && sourceName === currentName);
  });
  if (mapped) {
    const targetId = firstNumber(mapped, ["targetQualityProfileId", "targetProfileId", "profileId"]);
    const targetName = firstString(mapped, ["targetQualityProfileName", "targetProfileName", "name"]);
    const byMapping = profiles.find((profile) => (targetId !== undefined && profile.id === targetId) || (targetName !== undefined && profile.name === targetName));
    if (byMapping) {
      return byMapping;
    }
  }
  const byId = profiles.find((profile) => profile.id !== undefined && profile.id === target.qualityProfileId);
  if (byId) {
    return byId;
  }
  const byName = profiles.find((profile) => profile.name === currentName);
  if (byName) {
    return byName;
  }
  const currentProfile = currentProfiles.find((profile) => profile.id === target.qualityProfileId);
  const byCurrentName = currentProfile ? profiles.find((profile) => profile.name === currentProfile.name) : undefined;
  return byCurrentName ?? (profiles.length === 1 ? profiles[0] : undefined);
}

function evaluateCurrentFile(
  target: ImpactTarget,
  profile: ParsedQualityProfile | undefined,
  currentProfile: QualityProfileSummary | undefined,
  customFormatNamesById: Map<number, string>,
  customFormats: ParsedCustomFormat[],
  includeUnsupported: boolean
): JsonRecord {
  if (!target.currentFile) {
    return {
      itemType: target.itemType,
      id: target.id,
      title: target.title,
      qualityProfileId: target.qualityProfileId,
      status: "missing",
      reasons: ["No current file is available for this library item."]
    };
  }
  if (!profile) {
    return {
      itemType: target.itemType,
      id: target.id,
      title: target.title,
      qualityProfileId: target.qualityProfileId,
      fileId: target.currentFile.id,
      status: "unmappedProfile",
      reasons: ["No proposed quality profile could be mapped to this item."]
    };
  }
  const candidate = candidateFromMediaFile(target.currentFile);
  const evaluation = evaluateCandidate(candidate, profile, customFormats, includeUnsupported);
  const oldCutoffMet = currentProfile && candidate.quality && currentProfile.raw && typeof currentProfile.raw === "object"
    ? qualityMeetsCutoff(candidate.quality, parseQualityProfile(currentProfile.raw as JsonRecord, customFormatNamesById))
    : undefined;
  const cutoffChanged = oldCutoffMet !== undefined && oldCutoffMet !== evaluation.meetsCutoff;
  const currentScore = target.currentFile.customFormatScore ?? 0;
  const status = currentStatus(evaluation, currentScore, cutoffChanged);
  const changes = currentChanges(evaluation, currentScore, cutoffChanged);
  return {
    itemType: target.itemType,
    id: target.id,
    title: target.title,
    qualityProfile: { id: profile.id, name: profile.name },
    fileId: target.currentFile.id,
    currentQuality: target.currentFile.quality,
    currentScore,
    proposedScore: evaluation.score,
    matchedCustomFormats: evaluation.matchedCustomFormats,
    status,
    changes,
    reasons: evaluation.rejectionReasons,
    ...(evaluation.unsupportedSpecifications.length === 0 ? {} : { unsupportedSpecifications: evaluation.unsupportedSpecifications })
  };
}

async function evaluateTargetReleases(
  config: RuntimeConfig,
  target: ImpactTarget,
  profile: ParsedQualityProfile | undefined,
  customFormats: ParsedCustomFormat[],
  includeUnsupported: boolean
): Promise<{ releases: JsonRecord[]; errors: JsonRecord[] }> {
  if (!profile) {
    return { releases: [], errors: [] };
  }
  try {
    const releases = await clientFor(config, target.app).request("release", { query: releaseQuery(target) });
    return {
      releases: extractArray(releases).map((release) => evaluateRelease(target, normalizeReleaseCandidate(release), profile, customFormats, includeUnsupported)),
      errors: []
    };
  } catch (error) {
    return {
      releases: [],
      errors: [{
        itemType: target.itemType,
        id: target.id,
        title: target.title,
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }
}

function releaseQuery(target: ImpactTarget): Record<string, unknown> {
  return target.app === "radarr" ? { movieId: target.id } : { episodeId: target.id };
}

function evaluateRelease(
  target: ImpactTarget,
  release: ReleaseCandidate,
  profile: ParsedQualityProfile,
  customFormats: ParsedCustomFormat[],
  includeUnsupported: boolean
): JsonRecord {
  const evaluation = evaluateCandidate(release, profile, customFormats, includeUnsupported);
  const current = target.currentFile ? candidateFromMediaFile(target.currentFile) : undefined;
  const currentEvaluation = current ? evaluateCandidate(current, profile, customFormats, includeUnsupported) : undefined;
  const status = releaseStatus(evaluation, release, current, currentEvaluation, profile);
  return {
    itemType: target.itemType,
    id: target.id,
    title: target.title,
    releaseTitle: release.title,
    qualityProfile: { id: profile.id, name: profile.name },
    quality: release.quality,
    size: release.size,
    score: evaluation.score,
    matchedCustomFormats: evaluation.matchedCustomFormats,
    status,
    rejectionReasons: evaluation.rejectionReasons,
    ...(evaluation.unsupportedSpecifications.length === 0 ? {} : { unsupportedSpecifications: evaluation.unsupportedSpecifications }),
    raw: release.raw
  };
}

function evaluateCandidate(candidate: MatchCandidate, profile: ParsedQualityProfile, customFormats: ParsedCustomFormat[], includeUnsupported: boolean): Evaluation {
  const localMatches = matchCustomFormats(candidate, customFormats);
  const matchedCustomFormats = [...new Set([...candidate.customFormats, ...localMatches.map((match) => match.name)])];
  const score = calculateScore(profile, matchedCustomFormats);
  const qualityAllowed = !candidate.quality || profile.allowedQualities.size === 0 || profile.allowedQualities.has(candidate.quality);
  const meetsCutoff = candidate.quality ? qualityMeetsCutoff(candidate.quality, profile) : true;
  const rejectionReasons: string[] = [];
  if (!qualityAllowed) {
    rejectionReasons.push(`Quality ${candidate.quality ?? "unknown"} is not allowed by profile ${profile.name}.`);
  }
  if (score < profile.minFormatScore) {
    rejectionReasons.push(`Custom format score ${score} is below minimum ${profile.minFormatScore}.`);
  }
  const unsupportedSpecifications = includeUnsupported
    ? localMatches
      .filter((match) => match.unsupportedSpecifications.length > 0)
      .map((match) => ({ customFormat: match.name, specifications: match.unsupportedSpecifications }))
    : [];
  return {
    accepted: qualityAllowed && score >= profile.minFormatScore,
    qualityAllowed,
    meetsCutoff,
    score,
    matchedCustomFormats,
    rejectionReasons,
    unsupportedSpecifications
  };
}

function calculateScore(profile: ParsedQualityProfile, matchedCustomFormats: string[]): number {
  return matchedCustomFormats.reduce((total, name) => total + (profile.formatScoresByName.get(name) ?? 0), 0);
}

function qualityMeetsCutoff(quality: string, profile: ParsedQualityProfile): boolean {
  if (profile.cutoffRank === undefined) {
    return true;
  }
  const rank = profile.qualityRank.get(quality);
  return rank === undefined ? false : rank >= profile.cutoffRank;
}

function currentStatus(evaluation: Evaluation, currentScore: number, cutoffChanged: boolean): string {
  if (!evaluation.accepted) {
    return "fallsOut";
  }
  if (cutoffChanged) {
    return "cutoffChanged";
  }
  if (!evaluation.meetsCutoff) {
    return "wouldBecomeUpgradeable";
  }
  if (evaluation.score !== currentScore) {
    return "scoreChanged";
  }
  return "unchanged";
}

function currentChanges(evaluation: Evaluation, currentScore: number, cutoffChanged: boolean): string[] {
  const changes: string[] = [];
  if (!evaluation.accepted) {
    changes.push("fallsOut");
  }
  if (cutoffChanged) {
    changes.push("cutoffChanged");
  }
  if (evaluation.accepted && !evaluation.meetsCutoff) {
    changes.push("wouldBecomeUpgradeable");
  }
  if (evaluation.score !== currentScore) {
    changes.push("scoreChanged");
  }
  return changes.length > 0 ? changes : ["unchanged"];
}

function releaseStatus(evaluation: Evaluation, release: ReleaseCandidate, current: MatchCandidate | undefined, currentEvaluation: Evaluation | undefined, profile: ParsedQualityProfile): string {
  if (!evaluation.accepted) {
    return "wouldBeRejected";
  }
  if (!current) {
    return "newCandidate";
  }
  if (isUpgrade(release, current, evaluation.score, currentEvaluation?.score ?? calculateScore(profile, current.customFormats), profile)) {
    return "wouldUpgrade";
  }
  return "wouldBeAccepted";
}

function isUpgrade(release: ReleaseCandidate, current: MatchCandidate, releaseScore: number, currentScore: number, profile: ParsedQualityProfile): boolean {
  const releaseRank = release.quality ? profile.qualityRank.get(release.quality) : undefined;
  const currentRank = current.quality ? profile.qualityRank.get(current.quality) : undefined;
  if (releaseRank !== undefined && currentRank !== undefined && releaseRank !== currentRank) {
    return releaseRank > currentRank;
  }
  return releaseScore > currentScore;
}

function candidateFromMediaFile(file: MediaFileItem): MatchCandidate {
  return {
    title: firstString(file.raw, ["sceneName", "relativePath", "path"]) ?? file.title,
    quality: file.quality,
    qualityResolution: file.qualityResolution,
    languages: file.languages,
    releaseGroup: file.releaseGroup,
    customFormats: file.customFormats
  };
}

function normalizeReleaseCandidate(raw: unknown): ReleaseCandidate {
  const customFormats = extractCustomFormatNames(raw);
  const languages = extractLanguageNames(raw);
  return {
    raw,
    title: firstString(raw, ["title", "releaseTitle", "guid"]) ?? "unknown",
    quality: firstString(raw, ["quality.quality.name", "quality.name"]),
    qualityResolution: firstNumber(raw, ["quality.quality.resolution", "quality.resolution"]),
    languages,
    releaseGroup: firstString(raw, ["releaseGroup"]),
    indexer: firstString(raw, ["indexer", "indexerLabel"]),
    customFormats,
    size: firstNumber(raw, ["size"])
  };
}

function extractCustomFormatNames(item: unknown): string[] {
  const formats = valueAt(item, "customFormats");
  return Array.isArray(formats)
    ? formats.map((format) => firstString(format, ["name"])).filter((name): name is string => Boolean(name))
    : [];
}

function extractLanguageNames(item: unknown): string[] {
  const language = firstString(item, ["language.name"]);
  const languages = valueAt(item, "languages");
  const names = Array.isArray(languages)
    ? languages.map((entry) => firstString(entry, ["name"])).filter((name): name is string => Boolean(name))
    : [];
  return [...new Set(language ? [language, ...names] : names)];
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await run(items[currentIndex] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function decodeSearchWindow(cursor: string | undefined, batchSize: number): { start: number; batchSize: number } {
  if (!cursor) {
    return { start: 0, batchSize };
  }
  const parsed = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return { start: Number.isFinite(parsed) && parsed > 0 ? parsed : 0, batchSize };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function summarize(items: JsonRecord[], field: string): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = String(item[field] ?? "unknown");
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function summarizeChanges(items: JsonRecord[]): Array<{ value: string; count: number }> {
  const changes = items.flatMap((item) => Array.isArray(item.changes) ? item.changes : [item.status ?? "unknown"]);
  return summarize(changes.map((value) => ({ value })), "value");
}
