import { afterEach, describe, expect, it, vi } from "vitest";
import { createTools } from "../src/tools.js";
import type { RuntimeConfig } from "../src/types.js";

const config: RuntimeConfig = {
  timeoutMs: 1000,
  backupDir: "/tmp/backups",
  apps: {
    radarr: {
      app: "radarr",
      baseUrl: "http://radarr:7878",
      apiKey: "secret",
      apiBasePath: "/api/v3"
    }
  }
};

describe("mutation tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates custom format scores through quality profile formatItems", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 10,
        name: "HD",
        formatItems: [
          { format: 42, name: "HDR", score: 0 },
          { format: 99, name: "Language", score: 5 }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 10, ok: true }), { status: 200 }));

    const tool = createTools().find((candidate) => candidate.name === "update_custom_format_score");
    if (!tool) {
      throw new Error("update_custom_format_score is not registered");
    }

    await tool.handler({
      app: "radarr",
      id: 42,
      body: { qualityProfileId: 10, score: 25 },
      confirm: true
    }, { config });

    const putCall = fetchMock.mock.calls[1];
    expect(String(putCall?.[0])).toBe("http://radarr:7878/api/v3/qualityprofile/10");
    expect(JSON.parse(String((putCall?.[1] as RequestInit).body))).toMatchObject({
      formatItems: [
        { format: 42, score: 25 },
        { format: 99, score: 5 }
      ]
    });
  });

  it("keeps bulk score updates in dry-run mode unless dryRun is false", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const tool = createTools().find((candidate) => candidate.name === "bulk_update_scores");
    if (!tool) {
      throw new Error("bulk_update_scores is not registered");
    }

    const result = await tool.handler({
      app: "radarr",
      body: {
        qualityProfileId: 10,
        updates: [{ customFormatId: 42, score: 25 }]
      },
      confirm: true
    }, { config }) as {
      dryRun: boolean;
      applied: number;
      endpoint: string;
      updates: Array<{ customFormatId: number; score: number }>;
    };

    expect(result).toMatchObject({
      dryRun: true,
      applied: 0,
      endpoint: "qualityprofile/10",
      updates: [{ customFormatId: 42, score: 25 }]
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies bulk score updates only when dryRun is false", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 10,
        name: "HD",
        formatItems: [
          { format: 42, name: "HDR", score: 0 }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 10, ok: true }), { status: 200 }));
    const tool = createTools().find((candidate) => candidate.name === "bulk_update_scores");
    if (!tool) {
      throw new Error("bulk_update_scores is not registered");
    }

    await tool.handler({
      app: "radarr",
      body: {
        qualityProfileId: 10,
        updates: [{ customFormatId: 42, score: 25 }]
      },
      dryRun: false,
      confirm: true
    }, { config });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://radarr:7878/api/v3/qualityprofile/10");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://radarr:7878/api/v3/qualityprofile/10");
  });
});
