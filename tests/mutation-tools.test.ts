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
});
