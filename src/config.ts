import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { APPS, type AppConfig, type AppName, type RuntimeConfig } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BACKUP_DIR = ".servarr-analytics-backups";
const DEFAULT_API_BASE_PATH: Record<AppName, string> = {
  sonarr: "/api/v3",
  radarr: "/api/v3",
  prowlarr: "/api/v1"
};

export function normalizeBaseUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

function envName(app: AppName, suffix: string): string {
  return `${app.toUpperCase()}_${suffix}`;
}

function parseAppConfig(env: NodeJS.ProcessEnv, app: AppName): AppConfig | undefined {
  const baseUrl = env[envName(app, "URL")];
  const apiKey = env[envName(app, "API_KEY")];
  const apiBasePath = env[envName(app, "API_BASE_PATH")] ?? DEFAULT_API_BASE_PATH[app];

  if (!baseUrl && !apiKey) {
    return undefined;
  }

  if (!baseUrl || !apiKey) {
    throw new Error(`${app} requires both ${envName(app, "URL")} and ${envName(app, "API_KEY")}`);
  }

  return {
    app,
    baseUrl: normalizeBaseUrl(baseUrl, envName(app, "URL")),
    apiKey,
    apiBasePath: normalizeApiBasePath(apiBasePath, envName(app, "API_BASE_PATH"))
  };
}

export function normalizeApiBasePath(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/api/")) {
    throw new Error(`${name} must start with /api/`);
  }
  return `/${trimmed.split("/").filter(Boolean).join("/")}`;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const apps: Partial<Record<AppName, AppConfig>> = {};

  for (const app of APPS) {
    const appConfig = parseAppConfig(env, app);
    if (appConfig) {
      apps[app] = appConfig;
    }
  }

  const timeoutMs = Number.parseInt(env.SERVARR_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("SERVARR_TIMEOUT_MS must be a positive integer");
  }

  return {
    apps,
    timeoutMs,
    backupDir: resolve(env.SERVARR_BACKUP_DIR ?? DEFAULT_BACKUP_DIR)
  };
}

export function configuredApps(config: RuntimeConfig): AppName[] {
  return APPS.filter((app) => Boolean(config.apps[app]));
}

export function getAppConfig(config: RuntimeConfig, app: AppName): AppConfig {
  const appConfig = config.apps[app];
  if (!appConfig) {
    throw new Error(`${app} is not configured. Set ${envName(app, "URL")} and ${envName(app, "API_KEY")}.`);
  }
  return appConfig;
}

export async function ensureBackupDir(config: RuntimeConfig): Promise<void> {
  await mkdir(config.backupDir, { recursive: true });
}
