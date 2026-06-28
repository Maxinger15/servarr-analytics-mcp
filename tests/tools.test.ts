import { describe, expect, it } from "vitest";
import { mutationSchema, patchSchema } from "../src/schemas.js";
import { createTools, expectedToolNames } from "../src/tools.js";

describe("tool registry", () => {
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
});
