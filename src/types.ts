export const APPS = ["sonarr", "radarr", "prowlarr"] as const;
export type AppName = (typeof APPS)[number];

export type DetailLevel = "summary" | "normal" | "verbose" | "raw";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface AppConfig {
  app: AppName;
  baseUrl: string;
  apiKey: string;
  apiBasePath: string;
}

export interface RuntimeConfig {
  apps: Partial<Record<AppName, AppConfig>>;
  timeoutMs: number;
  backupDir: string;
}

export interface CommonQueryOptions {
  detail?: DetailLevel;
  page?: number;
  pageSize?: number;
  limit?: number;
  from?: string;
  to?: string;
  sampleRecords?: number;
  fields?: string[];
  groupBy?: string;
  cursor?: string;
}

export interface RequestOptions {
  method?: HttpMethod;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface ApiOperation {
  app?: AppName;
  path: string;
  method?: HttpMethod;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface ToolContext {
  config: RuntimeConfig;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: any;
  handler: (args: any, context: ToolContext) => Promise<unknown>;
}

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
}

export interface BackupFile {
  version: 1;
  createdAt: string;
  apps: AppName[];
  data: Record<string, unknown>;
}

export interface PatchOperation {
  app: AppName;
  method: Exclude<HttpMethod, "GET">;
  path: string;
  body?: unknown;
}

export interface CursorPayload {
  app: AppName;
  path: string;
  options: CommonQueryOptions;
  query?: Record<string, unknown>;
}
