import { afterEach, describe, expect, it, vi } from "vitest";
import { mutationSchema, patchSchema } from "../src/schemas.js";
import { createTools, expectedToolNames } from "../src/tools.js";
import type { RuntimeConfig } from "../src/types.js";

const testConfig: RuntimeConfig = {
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

describe("tool registry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers every documented tool name", () => {
    const registered = new Set(createTools().map((tool) => tool.name));

    for (const name of expectedToolNames) {
      expect(registered.has(name), name).toBe(true);
    }
  });

  it("has no duplicate tool names", () => {
    const names = createTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("requires confirm true for mutating tools", () => {
    expect(() =>
      mutationSchema.parse({
        app: "radarr",
        id: 1,
        body: {}
      })
    ).toThrow();
  });

  it("allows patch dry runs without confirmation but rejects empty operations", () => {
    expect(() => patchSchema.parse({ operations: [] })).toThrow();
    expect(patchSchema.parse({
      operations: [{ app: "sonarr", method: "PUT", path: "config/naming", body: {} }]
    })).toMatchObject({ dryRun: true });
  });

  it("rejects app-specific tools before calling unsupported endpoints", async () => {
    const tool = createTools().find((candidate) => candidate.name === "get_quality_profiles");
    if (!tool) {
      throw new Error("get_quality_profiles is not registered");
    }

    await expect(tool.handler({
      app: "prowlarr"
    }, {
      config: testConfig
    })).rejects.toThrow(/not supported for prowlarr/);
  });

  it("uses live-verified endpoint paths for metadata and Prowlarr stats", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify([]), { status: 200 })
    );
    const tools = new Map(createTools().map((tool) => [tool.name, tool]));

    await tools.get("get_metadata_profiles")?.handler({ app: "sonarr" }, { config: testConfig });
    await tools.get("get_indexer_stats")?.handler({}, { config: testConfig });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://sonarr:8989/api/v3/metadata");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://prowlarr:9696/api/v1/indexerstats");
  });

  it("rejects Prowlarr disk space before calling an unsupported endpoint", async () => {
    const tool = createTools().find((candidate) => candidate.name === "get_disk_space");
    if (!tool) {
      throw new Error("get_disk_space is not registered");
    }

    await expect(tool.handler({ app: "prowlarr" }, { config: testConfig })).rejects.toThrow(/not supported for prowlarr/);
  });
});
