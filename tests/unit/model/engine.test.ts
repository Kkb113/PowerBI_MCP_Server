import { describe, expect, it } from "vitest";
import {
  ModelError,
  applyModelChanges,
  findModelReferences,
  hashModelSpec,
} from "../../../src/model/index.js";
import { loadModelFixture } from "../../helpers/model.js";

interface CrudScenario {
  readonly objectType: string;
  readonly target: Record<string, string>;
  readonly createValue: Record<string, unknown>;
  readonly updateValue: Record<string, unknown>;
}

const crudScenarios: readonly CrudScenario[] = [
  {
    objectType: "expression",
    target: { objectType: "expression", name: "Temporary Expression" },
    createValue: { name: "Temporary Expression", kind: "m", expression: "1" },
    updateValue: {
      name: "Temporary Expression",
      kind: "m",
      expression: "2",
      description: "Updated",
    },
  },
  {
    objectType: "data_source",
    target: { objectType: "data_source", name: "Temporary Source" },
    createValue: {
      name: "Temporary Source",
      kind: "structured",
      connectionDetails: { protocol: "tds", address: { server: "example" } },
    },
    updateValue: {
      name: "Temporary Source",
      kind: "structured",
      description: "Updated",
      connectionDetails: { protocol: "tds", address: { server: "example-2" } },
    },
  },
  {
    objectType: "table",
    target: { objectType: "table", name: "Temporary Table" },
    createValue: { name: "Temporary Table" },
    updateValue: { name: "Temporary Table", description: "Updated" },
  },
  {
    objectType: "column",
    target: { objectType: "column", parentName: "Product", name: "Temporary Column" },
    createValue: {
      kind: "source",
      name: "Temporary Column",
      sourceColumn: "TemporaryColumn",
      dataType: "string",
    },
    updateValue: {
      kind: "source",
      name: "Temporary Column",
      sourceColumn: "TemporaryColumn2",
      dataType: "string",
      description: "Updated",
    },
  },
  {
    objectType: "partition",
    target: { objectType: "partition", parentName: "Product", name: "Temporary Partition" },
    createValue: {
      kind: "m",
      name: "Temporary Partition",
      mode: "import",
      expression: "1",
    },
    updateValue: {
      kind: "m",
      name: "Temporary Partition",
      mode: "import",
      expression: "2",
    },
  },
  {
    objectType: "measure",
    target: { objectType: "measure", parentName: "Product", name: "Temporary Measure" },
    createValue: {
      name: "Temporary Measure",
      expression: "1",
      description: "Temporary measure.",
      formatString: "0",
    },
    updateValue: {
      name: "Temporary Measure",
      expression: "2",
      description: "Updated measure.",
      formatString: "0.00",
    },
  },
  {
    objectType: "relationship",
    target: { objectType: "relationship", name: "Temporary Relationship" },
    createValue: {
      name: "Temporary Relationship",
      fromTable: "Product",
      fromColumn: "Product ID",
      toTable: "Calendar",
      toColumn: "Year",
      fromCardinality: "many",
      toCardinality: "one",
    },
    updateValue: {
      name: "Temporary Relationship",
      fromTable: "Product",
      fromColumn: "Product ID",
      toTable: "Calendar",
      toColumn: "Year",
      fromCardinality: "many",
      toCardinality: "one",
      active: false,
    },
  },
  {
    objectType: "hierarchy",
    target: { objectType: "hierarchy", parentName: "Product", name: "Temporary Hierarchy" },
    createValue: {
      name: "Temporary Hierarchy",
      levels: [{ name: "Product", column: "Product ID" }],
    },
    updateValue: {
      name: "Temporary Hierarchy",
      description: "Updated",
      levels: [{ name: "Product", column: "Product ID" }],
    },
  },
  {
    objectType: "calculation_group",
    target: { objectType: "calculation_group", name: "Temporary Group" },
    createValue: {
      tableName: "Temporary Group",
      items: [{ name: "Current", expression: "SELECTEDMEASURE()" }],
    },
    updateValue: {
      tableName: "Temporary Group",
      description: "Updated",
      precedence: 20,
      items: [{ name: "Current", expression: "SELECTEDMEASURE()" }],
    },
  },
  {
    objectType: "calculation_item",
    target: {
      objectType: "calculation_item",
      parentName: "Time Intelligence",
      name: "Temporary Item",
    },
    createValue: { name: "Temporary Item", expression: "SELECTEDMEASURE()" },
    updateValue: {
      name: "Temporary Item",
      expression: "SELECTEDMEASURE()",
      description: "Updated",
    },
  },
  {
    objectType: "role",
    target: { objectType: "role", name: "Temporary Role" },
    createValue: { name: "Temporary Role", tablePermissions: [] },
    updateValue: { name: "Temporary Role", description: "Updated", tablePermissions: [] },
  },
];

describe("atomic semantic-model CRUD", () => {
  it.each(crudScenarios)(
    "creates, updates, and deletes $objectType without changing the final model",
    (scenario) => {
      const before = loadModelFixture();
      const result = applyModelChanges(before, [
        { action: "create", target: scenario.target, value: scenario.createValue },
        { action: "update", target: scenario.target, value: scenario.updateValue },
        { action: "delete", target: scenario.target },
      ]);
      expect(result.operations.map((operation) => operation.action)).toEqual([
        "create",
        "update",
        "delete",
      ]);
      expect(result.beforeHash).toBe(result.afterHash);
      expect(result.diff.hasChanges).toBe(false);
      expect(hashModelSpec(before)).toBe(result.beforeHash);
    },
  );

  it.each(crudScenarios)("rejects duplicate $objectType and rolls back", (scenario) => {
    const before = loadModelFixture();
    const snapshot = structuredClone(before);
    expect(() =>
      applyModelChanges(before, [
        { action: "create", target: scenario.target, value: scenario.createValue },
        { action: "create", target: scenario.target, value: scenario.createValue },
      ]),
    ).toThrowError(expect.objectContaining({ code: "MODEL_OBJECT_ALREADY_EXISTS" }));
    expect(before).toEqual(snapshot);
  });

  it.each(crudScenarios)("rejects a missing $objectType", (scenario) => {
    const target = { ...scenario.target, name: "Does Not Exist" };
    expect(() =>
      applyModelChanges(loadModelFixture(), [{ action: "delete", target }]),
    ).toThrowError(expect.objectContaining({ code: "MODEL_OBJECT_NOT_FOUND" }));
  });

  it("supports successful renames and reports the semantic diff", () => {
    const model = loadModelFixture();
    const result = applyModelChanges(model, [
      {
        action: "create",
        target: { objectType: "table", name: "Rename Me" },
        value: { name: "Rename Me" },
      },
      {
        action: "rename",
        target: { objectType: "table", name: "Rename Me" },
        newName: "Renamed Table",
      },
      {
        action: "rename",
        target: { objectType: "role", name: "West Region Reader" },
        newName: "West Reader",
      },
      {
        action: "rename",
        target: { objectType: "calculation_group", name: "Time Intelligence" },
        newName: "Time Calc",
      },
    ]);
    expect(result.model.tables.some((table) => table.name === "Renamed Table")).toBe(true);
    expect(result.model.roles[0]!.name).toBe("West Reader");
    expect(result.model.calculationGroups[0]!.tableName).toBe("Time Calc");
    expect(result.diff.hasChanges).toBe(true);
  });

  it("rejects target/value mismatches, invalid changes, duplicate rename targets, and parents", () => {
    const model = loadModelFixture();
    expect(() =>
      applyModelChanges(model, [
        {
          action: "create",
          target: { objectType: "role", name: "Target" },
          value: { name: "Different", tablePermissions: [] },
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "MODEL_CHANGE_TARGET_MISMATCH" }));
    expect(() => applyModelChanges(model, [{ action: "unknown" }])).toThrowError(
      expect.objectContaining({ code: "MODEL_CHANGE_INVALID" }),
    );
    expect(() =>
      applyModelChanges(model, [
        {
          action: "rename",
          target: { objectType: "role", name: "West Region Reader" },
          newName: "West Region Reader",
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "MODEL_OBJECT_ALREADY_EXISTS" }));
    expect(() =>
      applyModelChanges(model, [
        {
          action: "delete",
          target: { objectType: "column", parentName: "Missing", name: "X" },
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "MODEL_PARENT_NOT_FOUND" }));
  });

  it("rolls back an update that violates final semantic invariants", () => {
    const model = loadModelFixture();
    const snapshot = structuredClone(model);
    const sales = structuredClone(model.tables.find((table) => table.name === "Sales Data")!);
    sales.columns = sales.columns.filter((column) => column.name !== "Amount");
    expect(() =>
      applyModelChanges(model, [
        {
          action: "update",
          target: { objectType: "table", name: "Sales Data" },
          value: sales,
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "MODEL_VALIDATION_FAILED" }));
    expect(model).toEqual(snapshot);
  });

  it("returns a no-op transaction for an empty batch", () => {
    const result = applyModelChanges(loadModelFixture(), []);
    expect(result.operations).toEqual([]);
    expect(result.beforeHash).toBe(result.afterHash);
  });
});

describe("dependency reporting", () => {
  it("reports structural, DAX, RLS, data-source, sort, hierarchy, and M dependencies", () => {
    const model = loadModelFixture();
    model.expressions.push({
      name: "Dependent Query",
      kind: "m",
      expression: 'let Value = #"Parameter – Server" in Value',
      annotations: [],
    });
    expect(findModelReferences(model, { objectType: "table", name: "Customer's" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectType: "relationship" }),
        expect.objectContaining({ objectType: "role" }),
      ]),
    );
    expect(
      findModelReferences(model, {
        objectType: "column",
        parentName: "Calendar",
        name: "Month Number",
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ property: "sortByColumn" })]));
    expect(
      findModelReferences(model, {
        objectType: "column",
        parentName: "Calendar",
        name: "Date",
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ objectType: "hierarchy" })]));
    expect(
      findModelReferences(model, { objectType: "data_source", name: "Warehouse Source" }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ objectType: "partition" })]));
    expect(
      findModelReferences(model, { objectType: "expression", name: "Parameter – Server" }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ objectType: "expression" })]));
    expect(
      findModelReferences(model, {
        objectType: "measure",
        parentName: "Sales Data",
        name: "Revenue Δ",
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ objectType: "measure" })]));
  });

  it("blocks destructive operations and exposes references safely", () => {
    try {
      applyModelChanges(loadModelFixture(), [
        {
          action: "delete",
          target: { objectType: "column", parentName: "Calendar", name: "Date" },
        },
      ]);
      throw new Error("Expected dependency conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      const modelError = error as ModelError;
      expect(modelError.code).toBe("MODEL_DEPENDENCY_CONFLICT");
      expect(modelError.references.length).toBeGreaterThan(0);
      expect(modelError.toJSON()).toMatchObject({ code: "MODEL_DEPENDENCY_CONFLICT" });
      expect(JSON.stringify(modelError)).not.toContain("cause");
    }
  });
});
