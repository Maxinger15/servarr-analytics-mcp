import { afterEach, describe, expect, it, vi } from "vitest";
import { createTools } from "../src/tools.js";
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
    radarr: {
      app: "radarr",
      baseUrl: "http://radarr:7878",
      apiKey: "secret",
      apiBasePath: "/api/v3"
    }
  }
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function mockServarrMediaResponses(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "sonarr" && url.pathname.endsWith("/series")) {
      return json([{ id: 7, title: "Show", qualityProfileId: 3 }]);
    }
    if (url.hostname === "sonarr" && url.pathname.endsWith("/episodefile")) {
      return json([
        {
          id: 70,
          seriesId: 7,
          size: 6_000_000_000,
          quality: { quality: { name: "WEBDL-2160p", resolution: 2160 } },
          languages: [{ name: "German" }],
          customFormats: [{ name: "WEBRip-2160p" }],
          customFormatScore: 10,
          mediaInfo: { videoCodec: "x264" }
        }
      ]);
    }
    if (url.hostname === "sonarr" && url.pathname.endsWith("/wanted/missing")) {
      return json({ records: [{ id: 100, seriesId: 7, title: "Missing Episode" }] });
    }
    if (url.hostname === "radarr" && url.pathname.endsWith("/movie")) {
      return json([
        {
          id: 9,
          title: "Movie",
          qualityProfileId: 4,
          movieFile: {
            id: 90,
            movieId: 9,
            size: 200,
            quality: { quality: { name: "Bluray-1080p", resolution: 1080 } },
            languages: [{ name: "English" }],
            customFormats: [{ name: "Remux" }],
            customFormatScore: 20,
            mediaInfo: { videoCodec: "x264" }
          }
        }
      ]);
    }
    if (url.pathname.endsWith("/customformat")) {
      return json([
        { id: 42, name: "WEBRip-2160p" },
        { id: 99, name: "Remux" }
      ]);
    }
    return json([]);
  });
}

describe("media-file analytics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts custom format hits from Sonarr episode files and Radarr movie files", async () => {
    mockServarrMediaResponses();
    const tool = createTools().find((candidate) => candidate.name === "custom_format_hits");
    if (!tool) {
      throw new Error("custom_format_hits is not registered");
    }

    const sonarrResult = await tool.handler({ app: "sonarr" }, { config }) as {
      data: { apps: Array<{ hits: Array<{ value: string; count: number }> }> };
    };
    const radarrResult = await tool.handler({ app: "radarr" }, { config }) as {
      data: { apps: Array<{ hits: Array<{ value: string; count: number }> }> };
    };

    expect(sonarrResult.data.apps[0]?.hits).toEqual([{ value: "WEBRip-2160p", count: 1 }]);
    expect(radarrResult.data.apps[0]?.hits).toEqual([{ value: "Remux", count: 1 }]);
  });

  it("summarizes Sonarr quality and codec from episode files", async () => {
    mockServarrMediaResponses();
    const tool = createTools().find((candidate) => candidate.name === "library_summary");
    if (!tool) {
      throw new Error("library_summary is not registered");
    }

    const result = await tool.handler({ app: "sonarr" }, { config }) as {
      data: { apps: Array<{ qualities: Array<{ value: string; count: number }>; codecs: Array<{ value: string; count: number }> }> };
    };

    expect(result.data.apps[0]?.qualities).toEqual([{ value: "WEBDL-2160p", count: 1 }]);
    expect(result.data.apps[0]?.codecs).toEqual([{ value: "x264", count: 1 }]);
  });

  it("uses Sonarr episode files for upgrade and storage savings candidates", async () => {
    mockServarrMediaResponses();
    const upgradeTool = createTools().find((candidate) => candidate.name === "upgrade_candidates");
    const savingsTool = createTools().find((candidate) => candidate.name === "estimated_storage_savings");
    if (!upgradeTool || !savingsTool) {
      throw new Error("candidate tools are not registered");
    }

    const upgradeResult = await upgradeTool.handler({ app: "sonarr" }, { config }) as {
      data: { apps: Array<{ missingOrNoFile: unknown[]; largeNonHevc: unknown[] }> };
    };
    const savingsResult = await savingsTool.handler({ app: "sonarr" }, { config }) as {
      data: { apps: Array<{ candidates: number; candidateBytes: number; estimatedSavingsBytes: number }> };
    };

    expect(upgradeResult.data.apps[0]?.missingOrNoFile).toHaveLength(1);
    expect(upgradeResult.data.apps[0]?.largeNonHevc).toHaveLength(1);
    expect(savingsResult.data.apps[0]).toMatchObject({
      candidates: 1,
      candidateBytes: 6_000_000_000,
      estimatedSavingsBytes: 2_100_000_000
    });
  });

  it("reports Sonarr file metadata from episode files and missing from wanted missing", async () => {
    mockServarrMediaResponses();
    const tool = createTools().find((candidate) => candidate.name === "report_storage_review");
    if (!tool) {
      throw new Error("report_storage_review is not registered");
    }

    const result = await tool.handler({ app: "sonarr" }, { config }) as {
      data: {
        apps: Array<{
          missingFiles: number;
          qualities: Array<{ value: string; count: number }>;
          codecs: Array<{ value: string; count: number }>;
          storageByCodec: Array<{ value: string; bytes: number; count: number }>;
          recommendations: string[];
        }>;
      };
    };

    expect(result.data.apps[0]).toMatchObject({
      missingFiles: 1,
      qualities: [{ value: "WEBDL-2160p", count: 1 }],
      codecs: [{ value: "x264", count: 1 }],
      storageByCodec: [{ value: "x264", bytes: 6_000_000_000, count: 1 }]
    });
    expect(result.data.apps[0]?.recommendations).toContain("Large non-HEVC/AV1 files are good candidates for a codec or size strategy simulation.");
  });

  it("simulates score changes against matched media files", async () => {
    mockServarrMediaResponses();
    const tool = createTools().find((candidate) => candidate.name === "simulate_score_change");
    if (!tool) {
      throw new Error("simulate_score_change is not registered");
    }

    const result = await tool.handler({
      app: "sonarr",
      proposedChange: {
        updates: [{ customFormatId: 42, score: 50 }]
      }
    }, { config }) as {
      data: {
        apps: Array<{
          affectedCandidates: number;
          scoreImpact?: {
            matchedFormats: string[];
            matchedFiles: number;
            scoreDistribution: Array<{ value: string; count: number }>;
          };
        }>;
      };
    };

    expect(result.data.apps[0]).toMatchObject({
      affectedCandidates: 1,
      scoreImpact: {
        matchedFormats: ["WEBRip-2160p"],
        matchedFiles: 1,
        scoreDistribution: [{ value: "10", count: 1 }]
      }
    });
  });
});
