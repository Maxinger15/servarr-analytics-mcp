import { describe, expect, it } from "vitest";
import { validatePatchOperations } from "../src/backup-tools.js";

describe("backup patch validation", () => {
  it("allows singleton config updates and item-specific collection updates", () => {
    expect(validatePatchOperations([
      { app: "radarr", method: "PUT", path: "config/naming", body: { id: 1 } },
      { app: "radarr", method: "PUT", path: "qualityprofile/2", body: { id: 2 } }
    ])).toEqual({ valid: true, operations: 2 });
  });

  it("rejects unsafe broad collection updates and unknown paths", () => {
    expect(() => validatePatchOperations([{ app: "radarr", method: "PUT", path: "qualityprofile", body: [] }])).toThrow(/specific item id/);
    expect(() => validatePatchOperations([{ app: "sonarr", method: "PUT", path: "system/status", body: {} }])).toThrow(/safe allowlist/);
  });
});
