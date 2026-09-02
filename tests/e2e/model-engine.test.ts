import { describe, expect, it } from "vitest";
import {
  applyModelChanges,
  buildTmslDefinition,
  diffModelSpecs,
  hashModelSpec,
  parseTmslDefinition,
} from "../../src/model/index.js";
import { loadModelFixture } from "../helpers/model.js";

describe("semantic-model definition pipeline", () => {
  it("validates, mutates, serializes, decodes, and round-trips an atomic batch", () => {
    const initial = loadModelFixture();
    const initialSnapshot = structuredClone(initial);
    const transaction = applyModelChanges(initial, [
      {
        action: "create",
        target: {
          objectType: "measure",
          parentName: "Sales Data",
          name: "Orders",
        },
        value: {
          name: "Orders",
          expression: "DISTINCTCOUNT('Sales Data'[Order ID])",
          description: "Distinct order count.",
          displayFolder: "Core Metrics",
          formatString: "#,0",
        },
      },
      {
        action: "create",
        target: {
          objectType: "calculation_item",
          parentName: "Time Intelligence",
          name: "Prior Year",
        },
        value: {
          name: "Prior Year",
          expression: "CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR('Calendar'[Date]))",
          description: "Prior-year transformation.",
          ordinal: 2,
        },
      },
      {
        action: "update",
        target: { objectType: "role", name: "West Region Reader" },
        value: {
          name: "West Region Reader",
          description: "Updated RLS policy.",
          modelPermission: "read",
          tablePermissions: [
            { table: "Customer's", filterExpression: "'Customer''s'[Region] = \"West\"" },
          ],
        },
      },
    ]);

    const definition = buildTmslDefinition(transaction.model);
    const roundTrip = parseTmslDefinition(definition);
    expect(initial).toEqual(initialSnapshot);
    expect(transaction.operations).toHaveLength(3);
    expect(transaction.beforeHash).toBe(hashModelSpec(initial));
    expect(transaction.afterHash).toBe(hashModelSpec(roundTrip.model));
    expect(transaction.afterHash).not.toBe(transaction.beforeHash);
    expect(diffModelSpecs(transaction.model, roundTrip.model).hasChanges).toBe(false);
    expect(roundTrip.model.tables.find((table) => table.name === "Sales Data")!.measures).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Orders" })]),
    );
    expect(roundTrip.model.calculationGroups[0]!.items.at(-1)?.name).toBe("Prior Year");
  });
});
