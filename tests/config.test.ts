import { describe, expect, it } from "vitest";
import { normalizeApiBasePath, normalizeBaseUrl, parseConfig } from "../src/config.js";

describe("config", () => {
  it("normalizes base URLs", () => {
    expect(normalizeBaseUrl("http://localhost:8989/", "SONARR_URL")).toBe("http://localhost:8989");
  });

  it("parses configured apps", () => {
    const config = parseConfig({
      SONARR_URL: "http://sonarr:8989",
      SONARR_API_KEY: "secret",
      SERVARR_TIMEOUT_MS: "1000",
      SERVARR_BACKUP_DIR: "/tmp/backups"
    });

    expect(config.apps.sonarr).toMatchObject({
      app: "sonarr",
      baseUrl: "http://sonarr:8989",
      apiKey: "secret",
      apiBasePath: "/api/v3"
    });
    expect(config.timeoutMs).toBe(1000);
    expect(config.backupDir).toBe("/tmp/backups");
  });

  it("requires url and api key together", () => {
    expect(() => parseConfig({ RADARR_URL: "http://radarr:7878" })).toThrow(/requires both/);
  });

  it("defaults prowlarr to api v1 and allows explicit api base override", () => {
    const config = parseConfig({
      PROWLARR_URL: "http://prowlarr:9696",
      PROWLARR_API_KEY: "secret",
      SONARR_URL: "http://sonarr:8989",
      SONARR_API_KEY: "secret",
      SONARR_API_BASE_PATH: "/api/v4/"
    });

    expect(config.apps.prowlarr?.apiBasePath).toBe("/api/v1");
    expect(config.apps.sonarr?.apiBasePath).toBe("/api/v4");
    expect(normalizeApiBasePath("/api/v3/", "TEST")).toBe("/api/v3");
    expect(() => normalizeApiBasePath("api/v3", "TEST")).toThrow(/must start/);
  });
});
