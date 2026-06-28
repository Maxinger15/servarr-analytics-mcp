import { describe, expect, it } from "vitest";
import { shapeResult } from "../src/response.js";

describe("shapeResult", () => {
  const records = [
    { id: 1, date: "2026-01-01T00:00:00Z", quality: { name: "HD" }, size: 10 },
    { id: 2, date: "2026-02-01T00:00:00Z", quality: { name: "UHD" }, size: 20 }
  ];

  it("applies paging and field projection", () => {
    const shaped = shapeResult(records, {
      detail: "verbose",
      page: 1,
      pageSize: 1,
      fields: ["id", "quality.name"]
    }) as { records: unknown[]; meta: { returnedRecords: number } };

    expect(shaped.meta.returnedRecords).toBe(1);
    expect(shaped.records).toEqual([{ id: 1, quality: { name: "HD" } }]);
  });

  it("groups summary data", () => {
    const shaped = shapeResult(records, {
      detail: "summary",
      groupBy: "quality.name"
    }) as { summary: { grouped: Array<{ value: string; count: number }> } };

    expect(shaped.summary.grouped).toEqual([
      { value: "HD", count: 1 },
      { value: "UHD", count: 1 }
    ]);
  });

  it("caps raw records", () => {
    const shaped = shapeResult(Array.from({ length: 1200 }, (_, id) => ({ id })), {
      detail: "raw",
      pageSize: 1200
    }) as { data: unknown[] };

    expect(shaped.data).toHaveLength(500);
  });
});
