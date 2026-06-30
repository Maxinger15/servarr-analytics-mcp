import { afterEach, describe, expect, it, vi } from "vitest";
import { matchCustomFormats, parseCustomFormat, parseQualityProfile } from "../src/profile-impact-tools.js";
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

function impactTool() {
  const tool = createTools().find((candidate) => candidate.name === "simulate_profile_impact");
  if (!tool) {
    throw new Error("simulate_profile_impact is not registered");
  }
  return tool;
}

describe("profile impact parser and matcher", () => {
  it("parses allowed qualities, cutoff order, and custom format scores", () => {
    const profile = parseQualityProfile({
      id: 10,
      name: "UHD",
      cutoff: { id: 3, name: "WEBDL-2160p" },
      items: [
        { quality: { id: 1, name: "WEBDL-1080p" }, allowed: true },
        { quality: { id: 2, name: "Bluray-1080p" }, allowed: false },
        { quality: { id: 3, name: "WEBDL-2160p" }, allowed: true }
      ],
      formatItems: [{ format: 42, score: 75 }]
    }, new Map([[42, "HDR"]]));

    expect(profile.allowedQualities.has("WEBDL-1080p")).toBe(true);
    expect(profile.allowedQualities.has("Bluray-1080p")).toBe(false);
    expect(profile.cutoffRank).toBe(1);
    expect(profile.formatScoresByName.get("HDR")).toBe(75);
  });

  it("matches supported custom format specs and reports unsupported specs", () => {
    const format = parseCustomFormat({
      id: 42,
      name: "HDR",
      specifications: [
        { implementation: "ReleaseTitleSpecification", fields: [{ name: "value", value: "HDR" }] },
        { implementation: "UnknownSpecification", fields: [{ name: "value", value: "ignored" }] }
      ]
    });

    const matches = matchCustomFormats({
      title: "Movie.2026.2160p.HDR.WEB-DL",
      quality: "WEBDL-2160p",
      qualityResolution: 2160,
      languages: ["English"],
      customFormats: []
    }, [format]);

    expect(matches).toEqual([{ name: "HDR", unsupportedSpecifications: ["UnknownSpecification"] }]);
  });
});

describe("simulate_profile_impact", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evaluates Radarr current files and live releases using read-only GET requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(init?.method).toBe("GET");
      const url = new URL(String(input));
      if (url.hostname === "radarr" && url.pathname.endsWith("/movie")) {
        return json([
          {
            id: 9,
            title: "Movie",
            qualityProfileId: 10,
            movieFile: {
              id: 90,
              movieId: 9,
              size: 100,
              quality: { quality: { id: 1, name: "WEBDL-1080p", resolution: 1080 } },
              customFormats: [],
              customFormatScore: 0
            }
          }
        ]);
      }
      if (url.hostname === "radarr" && url.pathname.endsWith("/release")) {
        expect(url.searchParams.get("movieId")).toBe("9");
        return json([
          {
            title: "Movie.2026.2160p.HDR.WEB-DL",
            quality: { quality: { id: 2, name: "WEBDL-2160p", resolution: 2160 } },
            size: 200,
            customFormats: []
          }
        ]);
      }
      return json([]);
    });

    const result = await impactTool().handler({
      app: "radarr",
      qualityProfiles: [{
        id: 10,
        name: "UHD",
        cutoff: { id: 2, name: "WEBDL-2160p" },
        minFormatScore: 10,
        items: [
          { quality: { id: 1, name: "WEBDL-1080p" }, allowed: true },
          { quality: { id: 2, name: "WEBDL-2160p" }, allowed: true }
        ],
        formatItems: [{ format: 42, score: 50 }]
      }],
      customFormats: [{
        id: 42,
        name: "HDR",
        specifications: [{ implementation: "ReleaseTitleSpecification", fields: [{ name: "value", value: "HDR" }] }]
      }]
    }, { config }) as {
      data: {
        currentFileImpacts: Array<{ status: string; reasons: string[] }>;
        liveReleaseImpacts: Array<{ status: string; score: number; matchedCustomFormats: string[] }>;
      };
    };

    expect(result.data.currentFileImpacts[0]).toMatchObject({
      status: "fallsOut",
      reasons: ["Custom format score 0 is below minimum 10."]
    });
    expect(result.data.liveReleaseImpacts[0]).toMatchObject({
      status: "wouldUpgrade",
      score: 50,
      matchedCustomFormats: ["HDR"]
    });
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toBe(true);
  });

  it("evaluates Sonarr episode releases in cursor batches", async () => {
    const releaseEpisodeIds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(init?.method).toBe("GET");
      const url = new URL(String(input));
      if (url.hostname === "sonarr" && url.pathname.endsWith("/series")) {
        return json([{ id: 7, title: "Show", qualityProfileId: 10 }]);
      }
      if (url.hostname === "sonarr" && url.pathname.endsWith("/episodefile")) {
        return json([
          {
            id: 500,
            seriesId: 7,
            size: 100,
            quality: { quality: { id: 1, name: "WEBDL-1080p", resolution: 1080 } },
            customFormats: [],
            customFormatScore: 0
          }
        ]);
      }
      if (url.hostname === "sonarr" && url.pathname.endsWith("/episode")) {
        return json([
          { id: 100, seriesId: 7, seasonNumber: 1, episodeNumber: 1, episodeFileId: 500 },
          { id: 101, seriesId: 7, seasonNumber: 1, episodeNumber: 2 }
        ]);
      }
      if (url.hostname === "sonarr" && url.pathname.endsWith("/release")) {
        releaseEpisodeIds.push(url.searchParams.get("episodeId") ?? "");
        return json([
          {
            title: `Show.S01E${url.searchParams.get("episodeId") === "100" ? "01" : "02"}.2160p.HDR.WEB-DL`,
            quality: { quality: { id: 2, name: "WEBDL-2160p", resolution: 2160 } },
            customFormats: []
          }
        ]);
      }
      return json([]);
    });

    const args = {
      app: "sonarr",
      search: { batchSize: 1 },
      qualityProfiles: [{
        id: 10,
        name: "UHD",
        cutoff: { id: 2, name: "WEBDL-2160p" },
        items: [
          { quality: { id: 1, name: "WEBDL-1080p" }, allowed: true },
          { quality: { id: 2, name: "WEBDL-2160p" }, allowed: true }
        ],
        formatItems: [{ format: 42, score: 50 }]
      }],
      customFormats: [{
        id: 42,
        name: "HDR",
        specifications: [{ implementation: "ReleaseTitleSpecification", fields: [{ name: "value", value: "HDR" }] }]
      }]
    };

    const first = await impactTool().handler(args, { config }) as {
      data: { search: { nextCursor?: string }; liveReleaseImpacts: Array<{ status: string }> };
    };
    const second = await impactTool().handler({
      ...args,
      search: { batchSize: 1, cursor: first.data.search.nextCursor }
    }, { config }) as {
      data: { search: { nextCursor?: string }; liveReleaseImpacts: Array<{ status: string }> };
    };

    expect(releaseEpisodeIds).toEqual(["100", "101"]);
    expect(first.data.liveReleaseImpacts[0]?.status).toBe("wouldUpgrade");
    expect(second.data.liveReleaseImpacts[0]?.status).toBe("newCandidate");
    expect(second.data.search.nextCursor).toBeUndefined();
  });
});
