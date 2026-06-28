import { describe, expect, it } from "vitest";
import {
  averageSize,
  bytesBy,
  countBy,
  duplicateValues,
  extractArray,
  groupHistoryByMonth,
  successRateByIndexer,
  valueAt
} from "../src/servarr-data.js";

describe("servarr data helpers", () => {
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
});
