import { getAppConfig } from "./config.js";
import type { AppName, RequestOptions, RuntimeConfig } from "./types.js";

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
    const normalizedPath = path.startsWith("/") ? path : `/api/v3/${path}`;
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
          "User-Agent": "servarr-analytics-mcp/0.1.0"
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
