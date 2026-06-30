import { afterEach, describe, expect, it, vi } from "vitest";
import {
  averageSize,
  bytesBy,
  countBy,
  duplicateValues,
  extractArray,
  groupHistoryByMonth,
  readDataset,
  successRateByIndexer,
  valueAt
} from "../src/servarr-data.js";
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

describe("servarr data helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts arrays from common Servarr paged response shapes", () => {
    expect(extractArray([{ id: 1 }])).toHaveLength(1);
    expect(extractArray({ records: [{ id: 1 }] })).toHaveLength(1);
    expect(extractArray({ items: [{ id: 1 }] })).toHaveLength(1);
  });

  it("reads nested paths and creates count distributions", () => {
    const rows = [{ quality: { name: "HD" }, size: 10 }, { quality: { name: "HD" }, size: 20 }, { quality: { name: "UHD" }, size: 30 }];

    expect(valueAt(rows[0], "quality.name")).toBe("HD");
    expect(countBy(rows, (row) => valueAt(row, "quality.name") as string)).toEqual([
      { value: "HD", count: 2 },
      { value: "UHD", count: 1 }
    ]);
    expect(bytesBy(rows, (row) => valueAt(row, "quality.name") as string, (row) => row.size)[0]).toEqual({ value: "HD", bytes: 30, count: 2 });
  });

  it("summarizes history by month and indexer success", () => {
    const events = [
      { app: "radarr" as const, eventType: "grabbed", date: "2026-01-01T00:00:00Z", indexer: "A", size: 100, raw: {} },
      { app: "radarr" as const, eventType: "downloadFolderImported", date: "2026-01-02T00:00:00Z", indexer: "A", size: 100, raw: {} },
      { app: "radarr" as const, eventType: "downloadFailed", date: "2026-02-01T00:00:00Z", indexer: "A", size: 50, raw: {} }
    ];

    expect(groupHistoryByMonth(events)[1]).toMatchObject({ month: "2026-01", grabs: 1, imports: 1, bytes: 200 });
    expect(successRateByIndexer(events)[0]).toMatchObject({ indexer: "A", grabs: 1, imports: 1, failures: 1, successRate: 100 });
    expect(averageSize(events)).toBe(83);
    expect(duplicateValues(["x", "x", "y"])).toEqual([{ value: "x", count: 2 }]);
  });

  it("loads Sonarr episode files into mediaFiles when requested", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/series")) {
        return json([{ id: 7, title: "Show", qualityProfileId: 3 }]);
      }
      if (url.pathname.endsWith("/episodefile")) {
        expect(url.searchParams.get("seriesId")).toBe("7");
        return json([
          {
            id: 70,
            seriesId: 7,
            size: 123,
            quality: { quality: { name: "WEBDL-2160p", resolution: 2160 } },
            languages: [{ name: "German" }],
            customFormats: [{ name: "WEBRip-2160p" }],
            customFormatScore: 50,
            mediaInfo: { videoCodec: "x265", audioCodec: "EAC3", videoDynamicRange: "HDR10" },
            releaseGroup: "GRP"
          }
        ]);
      }
      return json([]);
    });

    const dataset = await readDataset(config, "sonarr", { includeMediaFiles: true });

    expect(dataset.mediaFiles).toHaveLength(1);
    expect(dataset.mediaFiles[0]).toMatchObject({
      app: "sonarr",
      itemType: "episodeFile",
      seriesId: 7,
      title: "Show",
      qualityProfileId: 3,
      size: 123,
      quality: "WEBDL-2160p",
      qualityResolution: 2160,
      codec: "x265",
      audioCodec: "EAC3",
      hdr: "HDR10",
      releaseGroup: "GRP",
      languages: ["German"],
      customFormats: ["WEBRip-2160p"],
      customFormatScore: 50
    });
  });

  it("loads Radarr movie files from movie objects into mediaFiles when requested", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/movie")) {
        return json([
          {
            id: 9,
            title: "Movie",
            qualityProfileId: 4,
            movieFile: {
              id: 90,
              movieId: 9,
              size: 456,
              quality: { quality: { name: "Bluray-1080p", resolution: 1080 } },
              languages: [{ name: "English" }],
              customFormats: [{ name: "Remux" }],
              customFormatScore: 100,
              mediaInfo: { videoCodec: "x264" }
            }
          }
        ]);
      }
      return json([]);
    });

    const dataset = await readDataset(config, "radarr", { includeMediaFiles: true });

    expect(dataset.mediaFiles).toHaveLength(1);
    expect(dataset.mediaFiles[0]).toMatchObject({
      app: "radarr",
      itemType: "movieFile",
      movieId: 9,
      title: "Movie",
      qualityProfileId: 4,
      size: 456,
      quality: "Bluray-1080p",
      qualityResolution: 1080,
      codec: "x264",
      languages: ["English"],
      customFormats: ["Remux"],
      customFormatScore: 100
    });
  });
});
