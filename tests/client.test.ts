import { afterEach, describe, expect, it, vi } from "vitest";
import { ServarrClient } from "../src/client.js";
import type { RuntimeConfig } from "../src/types.js";

const config: RuntimeConfig = {
  timeoutMs: 1000,
  backupDir: "/tmp/backups",
  apps: {
    sonarr: {
      app: "sonarr",
      baseUrl: "http://sonarr:8989",
      apiKey: "secret",
      apiBasePath: "/api/v3"
    },
    prowlarr: {
      app: "prowlarr",
      baseUrl: "http://prowlarr:9696",
      apiKey: "secret",
      apiBasePath: "/api/v1"
    }
  }
};

describe("ServarrClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends api key header and parses json", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 })
    );

    const result = await new ServarrClient(config, "sonarr").request("system/status");

    expect(result).toEqual({ version: "1.0.0" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://sonarr:8989/api/v3/system/status"),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Api-Key": "secret" })
      })
    );
  });

  it("normalizes http errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "nope" }), { status: 500 })
    );

    await expect(new ServarrClient(config, "sonarr").request("system/status")).rejects.toThrow(/HTTP 500/);
  });

  it("uses the configured api base path per app", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 })
    );

    await new ServarrClient(config, "prowlarr").request("system/status");

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://prowlarr:9696/api/v1/system/status"),
      expect.any(Object)
    );
  });
});
