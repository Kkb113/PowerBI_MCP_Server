import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  diffModelSpecs,
  hashModelSpec,
  normalizeModelSpec,
  stableModelJson,
} from "../../../src/model/index.js";
import { loadModelFixture } from "../../helpers/model.js";

describe("model normalization and hashing", () => {
  it("sorts set-like collections but preserves semantic sequence", () => {
    const model = loadModelFixture();
    const expectedLevels = model.tables[0]!.hierarchies[0]!.levels.map((level) => level.name);
    const expectedItems = model.calculationGroups[0]!.items.map((item) => item.name);
    model.tables.reverse();
    model.relationships.reverse();
    model.calculationGroups[0]!.items.reverse();
    model.tables.find((table) => table.name === "Calendar")!.hierarchies[0]!.levels.reverse();

    const normalized = normalizeModelSpec(model);
    expect(normalized.tables.map((table) => table.name)).toEqual([
      "Calendar",
      "Customer's",
      "Product",
      "Sales Data",
    ]);
    expect(normalized.relationships.map((relationship) => relationship.name)).toEqual([
      "Sales_Calendar",
      "Sales_Customer",
      "Sales_Product",
    ]);
    expect(normalized.calculationGroups[0]!.items.map((item) => item.name)).toEqual(
      [...expectedItems].reverse(),
    );
    expect(normalized.tables[0]!.hierarchies[0]!.levels.map((level) => level.name)).toEqual(
      [...expectedLevels].reverse(),
    );
  });

  it("normalizes line endings and produces a deterministic SHA-256 hash", () => {
    const model = loadModelFixture();
    model.expressions[0]!.expression = "let\r\n  A = 1\rin A";
    const hash = hashModelSpec(model);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashModelSpec(structuredClone(model))).toBe(hash);
    expect(stableModelJson(model)).not.toContain("\r");
  });

  it("treats annotation ordering as non-semantic", () => {
    const left = loadModelFixture();
    left.annotations.push({ name: "Another", value: "Value" });
    const right = structuredClone(left);
    right.annotations.reverse();
    expect(hashModelSpec(left)).toBe(hashModelSpec(right));
  });

  it("canonicalizes object keys without reordering arrays", () => {
    expect(canonicalizeJson({ z: 1, a: [{ y: 2, x: 1 }], omitted: undefined })).toEqual({
      a: [{ x: 1, y: 2 }],
      z: 1,
    });
  });
});

describe("semantic diff", () => {
  it("returns no changes for equal models with reordered set-like collections", () => {
    const before = loadModelFixture();
    const after = structuredClone(before);
    after.tables.reverse();
    after.relationships.reverse();
    expect(diffModelSpecs(before, after)).toMatchObject({ hasChanges: false, totalChanges: 0 });
  });

  it("classifies added, changed, deleted, cosmetic, and breaking changes", () => {
    const before = loadModelFixture();
    const after = structuredClone(before);
    after.description = "Changed model";
    after.tables.find((table) => table.name === "Calendar")!.description = "Cosmetic";
    after.tables.find((table) => table.name === "Sales Data")!.measures[0]!.expression =
      "SUM('Sales Data'[Amount]) + 1";
    after.roles = [];
    after.tables.push({
      name: "Empty Table",
      hidden: false,
      columns: [],
      partitions: [],
      measures: [],
      hierarchies: [],
      annotations: [],
    });
    const diff = diffModelSpecs(before, after);
    expect(diff.added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectType: "table", path: "Empty Table" }),
      ]),
    );
    expect(diff.deleted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectType: "role", path: "West Region Reader" }),
      ]),
    );
    expect(diff.changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectType: "model", potentiallyBreaking: true }),
        expect.objectContaining({ objectType: "table", potentiallyBreaking: false }),
        expect.objectContaining({ objectType: "measure", potentiallyBreaking: true }),
      ]),
    );
    expect(diff.potentiallyBreaking.length).toBeGreaterThan(0);
    expect(diff.totalChanges).toBe(diff.added.length + diff.changed.length + diff.deleted.length);
  });
});
