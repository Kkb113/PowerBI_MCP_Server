import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEFINITION_PBISM,
  bimToModelSpec,
  buildTmslDefinition,
  decodeDefinitionPart,
  diffModelSpecs,
  encodeDefinitionPart,
  modelSpecToBim,
  parseTmslDefinition,
} from "../../../src/model/index.js";
import { loadModelBimFixture, loadModelFixture } from "../../helpers/model.js";

const pbismPath = fileURLToPath(
  new URL("../../fixtures/semantic-model/definition.pbism", import.meta.url),
);

describe("TMSL ModelSpec codec", () => {
  it("round-trips the golden model without a semantic diff", () => {
    const model = loadModelFixture();
    const converted = bimToModelSpec(modelSpecToBim(model));
    expect(diffModelSpecs(model, converted)).toMatchObject({ hasChanges: false, totalChanges: 0 });
    expect(converted.calculationGroups[0]!.items.map((item) => item.name)).toEqual([
      "Current",
      "Year to Date",
    ]);
    expect(converted.tables[0]!.hierarchies[0]!.levels.map((level) => level.name)).toEqual([
      "Year",
      "Month",
      "Day",
    ]);
  });

  it("converts every supported partition source and multiline expression", () => {
    const model = loadModelFixture();
    const bim = modelSpecToBim(model);
    const sourceTypes = bim.model.tables.flatMap((table) =>
      table.partitions.map((partition) => partition.source.type),
    );
    expect(sourceTypes).toEqual(expect.arrayContaining(["m", "query", "entity", "calculated"]));
    expect(bim.model.expressions[0]!.expression).toContain("\n");
  });

  it("builds deterministic Fabric definition parts and parses them", () => {
    const model = loadModelFixture();
    const definition = buildTmslDefinition(model);
    expect(definition).toMatchObject({
      format: "TMSL",
      parts: [
        { path: "model.bim", payloadType: "InlineBase64" },
        { path: "definition.pbism", payloadType: "InlineBase64" },
      ],
    });
    expect(decodeDefinitionPart(definition.parts[0]!)).toContain('"compatibilityLevel": 1702');
    const parsed = parseTmslDefinition(definition);
    expect(diffModelSpecs(model, parsed.model).hasChanges).toBe(false);
    expect(parsed.definitionProperties).toEqual(DEFAULT_DEFINITION_PBISM);
  });

  it("accepts the official fixture properties and an omitted format", () => {
    const model = loadModelFixture();
    const properties = JSON.parse(readFileSync(pbismPath, "utf8")) as unknown;
    const definition = buildTmslDefinition(model);
    delete definition.format;
    definition.parts[1] = encodeDefinitionPart("definition.pbism", JSON.stringify(properties));
    expect(parseTmslDefinition(definition).definitionProperties.version).toBe("5.0");
  });

  it("preserves optional definition parts across a rebuild", () => {
    const diagram = encodeDefinitionPart("diagramLayout.json", '{"version":"1.1.0"}');
    const definition = buildTmslDefinition(loadModelFixture(), DEFAULT_DEFINITION_PBISM, [diagram]);
    const parsed = parseTmslDefinition(definition);
    expect(parsed.additionalParts).toEqual([diagram]);
    expect(
      buildTmslDefinition(parsed.model, parsed.definitionProperties, parsed.additionalParts)
        .parts[2],
    ).toEqual(diagram);
    expect(() =>
      buildTmslDefinition(parsed.model, parsed.definitionProperties, [
        diagram,
        { ...diagram, path: "model.bim" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ADDITIONAL_DEFINITION_PART" }));
  });

  it.each([
    ["../model.bim", "INVALID_DEFINITION_PATH"],
    ["/model.bim", "INVALID_DEFINITION_PATH"],
    ["folder\\model.bim", "INVALID_DEFINITION_PATH"],
  ] as const)("rejects unsafe definition path %s", (path, code) => {
    expect(() => encodeDefinitionPart(path, "{}")).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects malformed and non-canonical base64", () => {
    expect(() =>
      decodeDefinitionPart({
        path: "model.bim",
        payload: "not base64!",
        payloadType: "InlineBase64",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_BASE64" }));
    expect(() =>
      decodeDefinitionPart({ path: "model.bim", payload: "YQ", payloadType: "InlineBase64" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_BASE64" }));
  });

  it("rejects missing, duplicate, mixed-format, and invalid JSON parts", () => {
    const definition = buildTmslDefinition(loadModelFixture());
    expect(() =>
      parseTmslDefinition({ format: "TMSL", parts: [definition.parts[0]!] }),
    ).toThrowError(expect.objectContaining({ code: "MISSING_DEFINITION_PART" }));
    expect(() =>
      parseTmslDefinition({ format: "TMSL", parts: [definition.parts[0]!, definition.parts[0]!] }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_DEFINITION_PART" }));
    expect(() =>
      parseTmslDefinition({
        format: "TMSL",
        parts: [...definition.parts, encodeDefinitionPart("definition/tables.tmdl", "table T")],
      }),
    ).toThrowError(expect.objectContaining({ code: "MIXED_DEFINITION_FORMAT" }));
    expect(() =>
      parseTmslDefinition({
        format: "TMSL",
        parts: [
          encodeDefinitionPart("model.bim", "{"),
          encodeDefinitionPart("definition.pbism", "{}"),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DEFINITION_JSON" }));
    expect(() => parseTmslDefinition({ format: "TMDL", parts: definition.parts })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_DEFINITION_FORMAT" }),
    );
  });

  it("rejects an invalid pbism contract and unsupported model.bim shape", () => {
    const definition = buildTmslDefinition(loadModelFixture());
    definition.parts[1] = encodeDefinitionPart(
      "definition.pbism",
      JSON.stringify({ version: "4.0" }),
    );
    expect(() => parseTmslDefinition(definition)).toThrowError(
      expect.objectContaining({ code: "INVALID_DEFINITION" }),
    );
    expect(() => bimToModelSpec({ compatibilityLevel: 1702, model: { tables: [] } })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_MODEL_BIM" }),
    );

    const invalidPartition = structuredClone(loadModelBimFixture());
    const calendarPartition = invalidPartition.model.tables.find(
      (table) => table.name === "Calendar",
    )!.partitions[0]!;
    calendarPartition.mode = "directQuery";
    expect(() => bimToModelSpec(invalidPartition)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_MODEL_BIM" }),
    );
  });

  it("rejects calculation groups with unsupported companion objects", () => {
    const bim = loadModelBimFixture();
    const groupTable = bim.model.tables.find((table) => table.name === "Time Intelligence")!;
    groupTable.measures.push({
      name: "Invalid",
      expression: "1",
      description: "Not permitted on a calculation group table.",
      formatString: "0",
      isHidden: false,
      annotations: [],
    });
    expect(() => bimToModelSpec(bim)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_CALCULATION_GROUP" }),
    );
  });

  it("fails closed for unknown fields and composite relationships", () => {
    const withUnknown = structuredClone(loadModelBimFixture()) as unknown as {
      unexpected?: boolean;
    };
    withUnknown.unexpected = true;
    expect(() => bimToModelSpec(withUnknown)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_MODEL_BIM" }),
    );

    const composite = structuredClone(loadModelBimFixture()) as unknown as {
      model: { relationships: unknown[] };
    };
    composite.model.relationships[0] = {
      name: "Composite",
      type: "multiColumn",
      fromTable: "Sales Data",
      fromColumns: ["Customer ID", "Product ID"],
      toTable: "Product",
      toColumns: ["Product ID", "Product ID"],
    };
    expect(() => bimToModelSpec(composite)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_MODEL_BIM" }),
    );
  });

  it("preserves Fabric lineage, annotations, and column metadata", () => {
    const original = loadModelFixture();
    const roundTrip = bimToModelSpec(modelSpecToBim(original));
    const sales = roundTrip.tables.find((table) => table.name === "Sales Data")!;
    const amount = sales.columns.find((column) => column.name === "Amount")!;
    expect(roundTrip.annotations).toEqual(original.annotations);
    expect(roundTrip.dataSources[0]!.annotations).toEqual(original.dataSources[0]!.annotations);
    expect(sales.lineageTag).toBe("7ef87eca-9e07-4dd8-960c-2b95898d4377");
    expect(amount).toMatchObject({
      isAvailableInMdx: false,
      lineageTag: "58ab9571-fbd4-47cc-adac-0dc7d97dcf42",
    });
    expect(sales.measures.find((measure) => measure.name === "Revenue Δ")!.lineageTag).toBe(
      "1f8f1a2a-06b6-4989-8af7-212719cf3617",
    );
  });

  it("validates every supplied definition part even when it is optional", () => {
    const definition = buildTmslDefinition(loadModelFixture());
    definition.parts.push({
      path: "../unsafe.json",
      payload: "e30=",
      payloadType: "InlineBase64",
    });
    expect(() => parseTmslDefinition(definition)).toThrowError(
      expect.objectContaining({ code: "INVALID_DEFINITION_PATH" }),
    );
  });
});
