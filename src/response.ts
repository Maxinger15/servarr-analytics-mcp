import type { CommonQueryOptions, ToolResponse } from "./types.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_RAW_ITEMS = 1000;

export function toolResponse(output: unknown): ToolResponse {
  const structuredContent =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : { result: output };

  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent
  };
}

export function normalizePaging(options: CommonQueryOptions): { page: number; pageSize: number; limit?: number } {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const limit = options.limit && options.limit > 0 ? options.limit : undefined;
  return limit ? { page, pageSize, limit } : { page, pageSize };
}

function getPathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, value);
}

function setPathValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1] ?? path] = value;
}

export function pickFields<T>(item: T, fields?: string[]): T | Record<string, unknown> {
  if (!fields || fields.length === 0 || !item || typeof item !== "object") {
    return item;
  }

  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    const value = getPathValue(item, field);
    if (value !== undefined) {
      setPathValue(picked, field, value);
    }
  }
  return picked;
}

function extractItems(data: unknown): { items: unknown[]; serverPaged: boolean; totalRecords?: number } | undefined {
  if (Array.isArray(data)) {
    return { items: data, serverPaged: false };
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.records)) {
      const totalRecords = typeof record.totalRecords === "number" ? record.totalRecords : undefined;
      return {
        items: record.records as unknown[],
        serverPaged: typeof record.page === "number",
        ...(totalRecords === undefined ? {} : { totalRecords })
      };
    }
    if (Array.isArray(record.results)) {
      return { items: record.results as unknown[], serverPaged: false };
    }
    if (Array.isArray(record.items) && (typeof record.page === "number" || typeof record.totalRecords === "number")) {
      const totalRecords = typeof record.totalRecords === "number" ? record.totalRecords : undefined;
      return {
        items: record.items as unknown[],
        serverPaged: typeof record.page === "number",
        ...(totalRecords === undefined ? {} : { totalRecords })
      };
    }
  }
  return undefined;
}

function dateValue(item: unknown): number | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  const candidate = record.date ?? record.dateAdded ?? record.added ?? record.airDateUtc ?? record.releaseDate;
  if (typeof candidate !== "string") {
    return undefined;
  }
  const time = Date.parse(candidate);
  return Number.isFinite(time) ? time : undefined;
}

function filterByDate(items: unknown[], options: CommonQueryOptions): unknown[] {
  const from = options.from ? Date.parse(options.from) : undefined;
  const to = options.to ? Date.parse(options.to) : undefined;
  if (!from && !to) {
    return items;
  }
  return items.filter((item) => {
    const time = dateValue(item);
    if (!time) {
      return true;
    }
    return (!from || time >= from) && (!to || time <= to);
  });
}

export function frequency(items: unknown[], path: string): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const rawValue = getPathValue(item, path);
    const value = rawValue === undefined || rawValue === null || rawValue === "" ? "unknown" : String(rawValue);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function sumByPath(items: unknown[], path: string): number {
  return items.reduce<number>((total, item) => {
    const value = getPathValue(item, path);
    return typeof value === "number" && Number.isFinite(value) ? total + value : total;
  }, 0);
}

export function shapeResult(data: unknown, options: CommonQueryOptions = {}, meta: Record<string, unknown> = {}): unknown {
  const detail = options.detail ?? "normal";
  const extracted = extractItems(data);

  if (!extracted) {
    return { detail, meta, data };
  }

  const items = extracted.items;
  const filtered = filterByDate(items, options);
  const { page, pageSize, limit } = normalizePaging(options);
  const cappedLimit = detail === "raw" ? Math.min(limit ?? MAX_RAW_ITEMS, MAX_RAW_ITEMS) : limit;
  const start = (page - 1) * pageSize;
  const selected = extracted.serverPaged ? filtered : filtered.slice(start, start + pageSize);
  const limited = cappedLimit ? selected.slice(0, cappedLimit) : selected;
  const projected = limited.map((item) => pickFields(item, options.fields));
  const sampleSize = Math.max(0, Math.min(options.sampleRecords ?? 5, 50));

  const baseMeta = {
    ...meta,
    totalRecords: extracted.totalRecords ?? items.length,
    filteredRecords: filtered.length,
    returnedRecords: projected.length,
    page,
    pageSize,
    serverPaged: extracted.serverPaged || undefined,
    rawCap: detail === "raw" ? MAX_RAW_ITEMS : undefined
  };

  if (detail === "raw") {
    return { detail, meta: baseMeta, data: projected };
  }

  const grouped = options.groupBy ? frequency(filtered, options.groupBy).slice(0, 25) : undefined;
  const summary = {
    count: filtered.length,
    sampleRecords: sampleSize > 0 ? projected.slice(0, sampleSize) : [],
    grouped
  };

  if (detail === "summary") {
    return { detail, meta: baseMeta, summary };
  }

  if (detail === "verbose") {
    return { detail, meta: baseMeta, summary, records: projected };
  }

  return { detail, meta: baseMeta, summary, records: projected.slice(0, sampleSize || 10) };
}
