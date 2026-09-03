import { describe, expect, it } from "vitest";
import {
  parseAndValidateModelSpec,
  validateModelSpec,
  type ModelSpec,
} from "../../../src/model/index.js";
import { loadModelFixture } from "../../helpers/model.js";

const codes = (model: ModelSpec): readonly string[] =>
  validateModelSpec(model).map((entry) => entry.code);

describe("ModelSpec validation", () => {
  it("accepts the complete golden model", () => {
    const model = loadModelFixture();
    expect(parseAndValidateModelSpec(model)).toEqual(model);
    expect(validateModelSpec(model)).toEqual([]);
  });

  it("converts Zod failures into stable model issues", () => {
    expect(() => parseAndValidateModelSpec({ tables: [] })).toThrowError(
      expect.objectContaining({ code: "MODEL_SCHEMA_INVALID" }),
    );
  });

  it("detects names case-insensitively across model and child scopes", () => {
    const model = loadModelFixture();
    model.tables.push({ ...structuredClone(model.tables[0]!), name: "calendar" });
    model.tables[0]!.columns.push({
      ...structuredClone(model.tables[0]!.columns[0]!),
      name: "date",
    });
    expect(codes(model)).toContain("DUPLICATE_NAME");
    expect(() => parseAndValidateModelSpec(model)).toThrowError(
      expect.objectContaining({ code: "MODEL_VALIDATION_FAILED" }),
    );
  });

  it("rejects duplicate annotation names within one object", () => {
    const model = loadModelFixture();
    model.annotations.push({ name: "fixturemodel", value: "Duplicate" });
    expect(codes(model)).toContain("DUPLICATE_NAME");
  });

  it("detects table, column, expression, data-source, and role reference failures", () => {
    const model = loadModelFixture();
    model.relationships[0]!.fromTable = "Missing";
    model.relationships[1]!.toColumn = "Missing";
    const productPartition = model.tables.find((table) => table.name === "Product")!.partitions[0]!;
    if (productPartition.kind === "entity") productPartition.expressionSource = "Missing";
    const queryPartition = model.tables.find((table) => table.name === "Sales Data")!
      .partitions[0]!;
    if (queryPartition.kind === "query") queryPartition.dataSourceName = "Missing";
    model.roles[0]!.tablePermissions[0]!.table = "Missing";
    expect(codes(model)).toEqual(
      expect.arrayContaining([
        "MISSING_TABLE",
        "MISSING_COLUMN",
        "MISSING_EXPRESSION",
        "MISSING_DATA_SOURCE",
      ]),
    );
  });

  it("detects invalid sort-by and hierarchy references, including self-reference", () => {
    const model = loadModelFixture();
    const calendar = model.tables.find((table) => table.name === "Calendar")!;
    calendar.columns[0]!.sortByColumn = "Date";
    calendar.columns[1]!.sortByColumn = "Missing";
    calendar.hierarchies[0]!.levels[0]!.column = "Missing";
    expect(codes(model)).toEqual(expect.arrayContaining(["SELF_REFERENCE", "MISSING_COLUMN"]));
  });

  it("rejects binary columns before a Direct Lake definition reaches Fabric", () => {
    const model = loadModelFixture();
    const product = model.tables.find((table) => table.name === "Product")!;
    product.columns[0]!.dataType = "binary";

    const finding = validateModelSpec(model).find(
      (issue) => issue.code === "DIRECT_LAKE_BINARY_COLUMN_UNSUPPORTED",
    );
    expect(finding?.path).toMatch(/\.columns\[0\]\.dataType$/u);
    expect(finding?.message).toContain("Product");
    expect(() => parseAndValidateModelSpec(model)).toThrowError(
      expect.objectContaining({ code: "MODEL_VALIDATION_FAILED" }),
    );
  });

  it("limits calculated-table inference metadata to calculated tables", () => {
    const model = loadModelFixture();
    const product = model.tables.find((table) => table.name === "Product")!;
    const column = product.columns[0]!;
    if (column.kind !== "source") throw new Error("Expected a source column fixture.");
    column.nameInferred = true;

    expect(codes(model)).toContain("CALCULATED_TABLE_COLUMN_METADATA_INVALID");
  });

  it("detects relationship self-reference and calculation-group collisions", () => {
    const model = loadModelFixture();
    model.relationships[0]!.fromTable = "Calendar";
    model.relationships[0]!.fromColumn = "Date";
    model.calculationGroups[0]!.tableName = "calendar";
    model.calculationGroups[0]!.items.push({
      ...structuredClone(model.calculationGroups[0]!.items[0]!),
      name: "current",
      ordinal: 1,
    });
    expect(codes(model)).toEqual(
      expect.arrayContaining(["SELF_REFERENCE", "DUPLICATE_NAME", "DUPLICATE_ORDINAL"]),
    );
  });

  it("rejects missing qualified and unqualified DAX references", () => {
    const model = loadModelFixture();
    const measures = model.tables.find((table) => table.name === "Sales Data")!.measures;
    measures[0]!.expression = "SUM(Missing[Amount])";
    measures[1]!.expression = "[Unknown Measure]";
    expect(codes(model).filter((code) => code === "MISSING_DAX_REFERENCE")).toHaveLength(2);
  });

  it("rejects a missing calculation-group column reference", () => {
    const model = loadModelFixture();
    model.tables.find((table) => table.name === "Sales Data")!.measures[0]!.expression =
      "SELECTEDVALUE('Time Intelligence'[Missing])";
    expect(codes(model)).toContain("MISSING_DAX_REFERENCE");
  });

  it("allows unqualified current-table columns in calculated columns and RLS", () => {
    const model = loadModelFixture();
    const calendar = model.tables.find((table) => table.name === "Calendar")!;
    const year = calendar.columns.find((column) => column.name === "Year")!;
    if (year.kind === "calculated") year.expression = "YEAR([Date])";
    expect(validateModelSpec(model)).toEqual([]);
  });

  it("detects circular measure dependencies but does not confuse a qualified column", () => {
    const model = loadModelFixture();
    const sales = model.tables.find((table) => table.name === "Sales Data")!;
    sales.measures[0]!.expression = "[Average Ticket]";
    sales.measures[1]!.expression = "[Revenue Δ]";
    expect(codes(model)).toContain("CIRCULAR_MEASURE_DEPENDENCY");

    sales.measures[0]!.expression = "SUM('Sales Data'[Amount])";
    sales.measures[1]!.expression = "SUM('Sales Data'[Revenue Δ])";
    sales.columns.push({
      kind: "source",
      name: "Revenue Δ",
      sourceColumn: "RevenueDelta",
      dataType: "decimal",
      hidden: false,
      key: false,
      summarizeBy: "sum",
      annotations: [],
    });
    expect(codes(model)).not.toContain("CIRCULAR_MEASURE_DEPENDENCY");
  });
});
