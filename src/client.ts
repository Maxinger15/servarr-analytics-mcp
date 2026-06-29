import { getAppConfig } from "./config.js";
import { PACKAGE_VERSION } from "./version.js";
import type { AppName, PageResult, PaginationOptions, RequestOptions, RuntimeConfig } from "./types.js";

export class ServarrApiError extends Error {
  constructor(
    message: string,
    readonly app: AppName,
    readonly status?: number,
    readonly responseBody?: unknown
  ) {
    super(message);
    this.name = "ServarrApiError";
  }
}

function appendQuery(url: URL, query: Record<string, unknown> | undefined): void {
  if (!query) {
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

export class ServarrClient {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly app: AppName
  ) {}

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const appConfig = getAppConfig(this.config, this.app);
    const normalizedPath = path.startsWith("/") ? path : `${appConfig.apiBasePath}/${path}`;
    const url = new URL(normalizedPath, `${appConfig.baseUrl}/`);
    appendQuery(url, options.query);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const requestInit: RequestInit = {
        method: options.method ?? "GET",
        signal: controller.signal,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-Api-Key": appConfig.apiKey,
          "User-Agent": `servarr-analytics-mcp/${PACKAGE_VERSION}`
        }
      };
      if (options.body !== undefined) {
        requestInit.body = JSON.stringify(options.body);
      }

      const response = await fetch(url, requestInit);

      const text = await response.text();
      const body = text ? parseJson(text) : undefined;

      if (!response.ok) {
        throw new ServarrApiError(
          `${this.app} API request failed with HTTP ${response.status}`,
          this.app,
          response.status,
          body
        );
      }

      return body as T;
    } catch (error) {
      if (error instanceof ServarrApiError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ServarrApiError(`${this.app} API request failed: ${message}`, this.app);
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestPaged<T = unknown>(path: string, options: PaginationOptions = {}): Promise<PageResult<T>> {
    const pageSize = Math.min(Math.max(1, options.pageSize ?? 100), 500);
    const firstPage = Math.max(1, options.page ?? 1);
    const limit = options.limit && options.limit > 0 ? options.limit : undefined;
    const records: T[] = [];
    let page = firstPage;
    let totalRecords: number | undefined;

    while (true) {
      const response = await this.request<unknown>(path, {
        query: {
          ...options.query,
          page,
          pageSize
        }
      });
      const normalized = normalizePage<T>(response, page, pageSize);
      totalRecords = normalized.totalRecords;
      records.push(...normalized.records);

      if (limit && records.length >= limit) {
        return {
          page: firstPage,
          pageSize,
          ...(totalRecords === undefined ? {} : { totalRecords }),
          records: records.slice(0, limit)
        };
      }

      const knownTotalReached = totalRecords !== undefined && records.length >= Math.max(0, totalRecords - (firstPage - 1) * pageSize);
      const shortPage = normalized.records.length < pageSize;
      if (knownTotalReached || shortPage || normalized.records.length === 0) {
        return {
          page: firstPage,
          pageSize,
          ...(totalRecords === undefined ? {} : { totalRecords }),
          records
        };
      }

      page += 1;
    }
  }

  async status(): Promise<unknown> {
    return this.request("system/status");
  }

  async health(): Promise<unknown> {
    return this.request("health");
  }
}

export function clientFor(config: RuntimeConfig, app: AppName): ServarrClient {
  return new ServarrClient(config, app);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizePage<T>(response: unknown, page: number, pageSize: number): PageResult<T> {
  if (Array.isArray(response)) {
    return {
      page,
      pageSize,
      totalRecords: response.length,
      records: response as T[]
    };
  }

  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if (Array.isArray(record.records)) {
      const responsePage = typeof record.page === "number" ? record.page : page;
      const responsePageSize = typeof record.pageSize === "number" ? record.pageSize : pageSize;
      const totalRecords = typeof record.totalRecords === "number" ? record.totalRecords : undefined;
      return {
        page: responsePage,
        pageSize: responsePageSize,
        ...(totalRecords === undefined ? {} : { totalRecords }),
        records: record.records as T[]
      };
    }
  }

  return {
    page,
    pageSize,
    totalRecords: 1,
    records: [response as T]
  };
}
