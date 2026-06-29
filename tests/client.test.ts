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

  it("collects paged records until total records are reached", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        page: 1,
        pageSize: 2,
        totalRecords: 3,
        records: [{ id: 1 }, { id: 2 }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        page: 2,
        pageSize: 2,
        totalRecords: 3,
        records: [{ id: 3 }]
      }), { status: 200 }));

    const result = await new ServarrClient(config, "sonarr").requestPaged("history", {
      pageSize: 2,
      query: { sortKey: "date" }
    });

    expect(result).toEqual({
      page: 1,
      pageSize: 2,
      totalRecords: 3,
      records: [{ id: 1 }, { id: 2 }, { id: 3 }]
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://sonarr:8989/api/v3/history?sortKey=date&page=1&pageSize=2");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://sonarr:8989/api/v3/history?sortKey=date&page=2&pageSize=2");
  });

  it("honors paged request limits", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        page: 1,
        pageSize: 2,
        totalRecords: 4,
        records: [{ id: 1 }, { id: 2 }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        page: 2,
        pageSize: 2,
        totalRecords: 4,
        records: [{ id: 3 }, { id: 4 }]
      }), { status: 200 }));

    const result = await new ServarrClient(config, "sonarr").requestPaged("history", {
      pageSize: 2,
      limit: 3
    });

    expect(result.records).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("normalizes array responses as one page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: 1 }]), { status: 200 })
    );

    const result = await new ServarrClient(config, "sonarr").requestPaged("qualityprofile");

    expect(result).toEqual({
      page: 1,
      pageSize: 100,
      totalRecords: 1,
      records: [{ id: 1 }]
    });
  });
});
