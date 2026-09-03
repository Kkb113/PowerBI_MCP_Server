import type { SemanticModelDefinition } from "../clients/schemas.js";
import { ModelError, type ModelIssue } from "./errors.js";
import { canonicalizeJson, normalizeModelSpec } from "./normalize.js";
import {
  definitionPbismSchema,
  modelBimSchema,
  type DefinitionPbism,
  type ModelBim,
  type ModelSpec,
} from "./schemas.js";
import { parseAndValidateModelSpec } from "./validation.js";

export const MODEL_BIM_PATH = "model.bim";
export const DEFINITION_PBISM_PATH = "definition.pbism";

export const DEFAULT_DEFINITION_PBISM: DefinitionPbism = definitionPbismSchema.parse({
  $schema:
    "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",
  version: "5.0",
  settings: { qnaEnabled: false },
});

const issue = (code: string, path: string, message: string): ModelIssue => ({
  code,
  path,
  message,
});

const expressionText = (value: string | readonly string[]): string =>
  (typeof value === "string" ? value : value.join("\n"))
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");

const validDefinitionPath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.split("/").includes("..") &&
  /^[A-Za-z0-9._/-]+$/u.test(path);

export function encodeDefinitionPart(
  path: string,
  text: string,
): SemanticModelDefinition["parts"][number] {
  if (!validDefinitionPath(path)) {
    throw new ModelError("INVALID_DEFINITION_PATH", `Definition path '${path}' is not safe.`, {
      issues: [
        issue(
          "INVALID_PATH",
          "path",
          "Use a relative Fabric definition path without '..' segments.",
        ),
      ],
    });
  }
  return {
    path,
    payload: Buffer.from(text, "utf8").toString("base64"),
    payloadType: "InlineBase64",
  };
}

export function decodeDefinitionPart(part: SemanticModelDefinition["parts"][number]): string {
  if (!validDefinitionPath(part.path)) {
    throw new ModelError("INVALID_DEFINITION_PATH", `Definition path '${part.path}' is not safe.`);
  }
  const payload = part.payload;
  const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
  if (!base64Pattern.test(payload)) {
    throw new ModelError("INVALID_BASE64", `Definition part '${part.path}' is not valid base64.`);
  }
  const decoded = Buffer.from(payload, "base64");
  if (decoded.toString("base64") !== payload) {
    throw new ModelError(
      "INVALID_BASE64",
      `Definition part '${part.path}' is not canonical base64.`,
    );
  }
  return decoded.toString("utf8");
}

const parseJson = (path: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ModelError(
      "INVALID_DEFINITION_JSON",
      `Definition part '${path}' is not valid JSON.`,
      {
        cause,
      },
    );
  }
};

export function modelSpecToBim(input: unknown): ModelBim {
  const model = normalizeModelSpec(input);
  const tables = model.tables.map((table) => ({
    name: table.name,
    ...(table.description === undefined ? {} : { description: table.description }),
    isHidden: table.hidden,
    columns: table.columns.map((column) =>
      column.kind === "source"
        ? {
            name: column.name,
            sourceColumn: column.sourceColumn,
            dataType: column.dataType,
            ...(column.description === undefined ? {} : { description: column.description }),
            ...(column.formatString === undefined ? {} : { formatString: column.formatString }),
            isHidden: column.hidden,
            isKey: column.key,
            ...(column.sortByColumn === undefined ? {} : { sortByColumn: column.sortByColumn }),
            summarizeBy: column.summarizeBy,
            ...(column.isDefaultLabel === undefined
              ? {}
              : { isDefaultLabel: column.isDefaultLabel }),
            ...(column.isAvailableInMdx === undefined
              ? {}
              : { isAvailableInMdx: column.isAvailableInMdx }),
            ...(column.lineageTag === undefined ? {} : { lineageTag: column.lineageTag }),
            annotations: column.annotations,
          }
        : {
            type: "calculated" as const,
            name: column.name,
            expression: column.expression,
            dataType: column.dataType,
            ...(column.description === undefined ? {} : { description: column.description }),
            ...(column.formatString === undefined ? {} : { formatString: column.formatString }),
            isHidden: column.hidden,
            ...(column.sortByColumn === undefined ? {} : { sortByColumn: column.sortByColumn }),
            summarizeBy: column.summarizeBy,
            ...(column.isDefaultLabel === undefined
              ? {}
              : { isDefaultLabel: column.isDefaultLabel }),
            ...(column.isAvailableInMdx === undefined
              ? {}
              : { isAvailableInMdx: column.isAvailableInMdx }),
            ...(column.lineageTag === undefined ? {} : { lineageTag: column.lineageTag }),
            annotations: column.annotations,
          },
    ),
    partitions: table.partitions.map((partition) => {
      switch (partition.kind) {
        case "m":
          return {
            name: partition.name,
            mode: partition.mode,
            source: { type: "m" as const, expression: partition.expression },
            annotations: partition.annotations,
          };
        case "query":
          return {
            name: partition.name,
            mode: partition.mode,
            source: {
              type: "query" as const,
              query: partition.query,
              dataSource: partition.dataSourceName,
            },
            annotations: partition.annotations,
          };
        case "entity":
          return {
            name: partition.name,
            mode: partition.mode,
            source: {
              type: "entity" as const,
              entityName: partition.entityName,
              ...(partition.schemaName === undefined ? {} : { schemaName: partition.schemaName }),
              dataSource: partition.dataSourceName,
            },
            annotations: partition.annotations,
          };
        case "calculated":
          return {
            name: partition.name,
            mode: partition.mode,
            source: { type: "calculated" as const, expression: partition.expression },
            annotations: partition.annotations,
          };
      }
    }),
    measures: table.measures.map((measure) => ({
      name: measure.name,
      expression: measure.expression,
      description: measure.description,
      ...(measure.displayFolder === undefined ? {} : { displayFolder: measure.displayFolder }),
      formatString: measure.formatString,
      isHidden: measure.hidden,
      ...(measure.lineageTag === undefined ? {} : { lineageTag: measure.lineageTag }),
      annotations: measure.annotations,
    })),
    hierarchies: table.hierarchies.map((hierarchy) => ({
      name: hierarchy.name,
      ...(hierarchy.description === undefined ? {} : { description: hierarchy.description }),
      isHidden: hierarchy.hidden,
      levels: hierarchy.levels.map((level, ordinal) => ({ ...level, ordinal })),
      ...(hierarchy.lineageTag === undefined ? {} : { lineageTag: hierarchy.lineageTag }),
      annotations: hierarchy.annotations,
    })),
    ...(table.lineageTag === undefined ? {} : { lineageTag: table.lineageTag }),
    annotations: table.annotations,
  }));

  const calculationGroupTables = model.calculationGroups.map((group) => ({
    name: group.tableName,
    ...(group.description === undefined ? {} : { description: group.description }),
    isHidden: false,
    columns: [
      {
        name: group.columnName ?? group.tableName,
        sourceColumn: "Name",
        dataType: "string" as const,
        isHidden: false,
        isKey: false,
        summarizeBy: "none" as const,
        ...(group.columnLineageTag === undefined ? {} : { lineageTag: group.columnLineageTag }),
        annotations: group.columnAnnotations,
      },
    ],
    partitions: [
      {
        name: group.tableName,
        mode: "import" as const,
        source: { type: "calculationGroup" as const },
        annotations: [],
      },
    ],
    measures: [],
    hierarchies: [],
    calculationGroup: {
      precedence: group.precedence,
      calculationItems: group.items.map((item) => ({
        name: item.name,
        expression: item.expression,
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.formatStringExpression === undefined
          ? {}
          : { formatStringDefinition: { expression: item.formatStringExpression } }),
        ...(item.ordinal === undefined ? {} : { ordinal: item.ordinal }),
      })),
    },
    ...(group.lineageTag === undefined ? {} : { lineageTag: group.lineageTag }),
    annotations: group.annotations,
  }));

  return modelBimSchema.parse({
    compatibilityLevel: model.compatibilityLevel,
    model: {
      culture: model.culture,
      ...(model.sourceQueryCulture === undefined
        ? {}
        : { sourceQueryCulture: model.sourceQueryCulture }),
      ...(model.description === undefined ? {} : { description: model.description }),
      defaultPowerBIDataSourceVersion: model.defaultPowerBIDataSourceVersion,
      discourageImplicitMeasures: model.discourageImplicitMeasures,
      dataAccessOptions: model.dataAccessOptions,
      dataSources: model.dataSources.map((source) => ({
        type: "structured",
        name: source.name,
        ...(source.description === undefined ? {} : { description: source.description }),
        connectionDetails: source.connectionDetails,
        ...(source.options === undefined ? {} : { options: source.options }),
        annotations: source.annotations,
      })),
      expressions: model.expressions.map((expression) => ({
        name: expression.name,
        kind: "m",
        expression: expression.expression,
        ...(expression.description === undefined ? {} : { description: expression.description }),
        ...(expression.lineageTag === undefined ? {} : { lineageTag: expression.lineageTag }),
        annotations: expression.annotations,
      })),
      tables: [...tables, ...calculationGroupTables],
      relationships: model.relationships.map((relationship) => ({
        name: relationship.name,
        type: "singleColumn",
        fromTable: relationship.fromTable,
        fromColumn: relationship.fromColumn,
        toTable: relationship.toTable,
        toColumn: relationship.toColumn,
        fromCardinality: relationship.fromCardinality,
        toCardinality: relationship.toCardinality,
        crossFilteringBehavior: relationship.crossFilteringBehavior,
        ...(relationship.securityFilteringBehavior === undefined
          ? {}
          : { securityFilteringBehavior: relationship.securityFilteringBehavior }),
        isActive: relationship.active,
        annotations: relationship.annotations,
      })),
      roles: model.roles.map((role) => ({
        name: role.name,
        ...(role.description === undefined ? {} : { description: role.description }),
        modelPermission: role.modelPermission,
        tablePermissions: role.tablePermissions.map((permission) => ({
          name: permission.table,
          filterExpression: permission.filterExpression,
        })),
        annotations: role.annotations,
      })),
      cultures: [],
      functions: [],
      perspectives: [],
      annotations: model.annotations,
    },
  });
}

export function bimToModelSpec(input: unknown): ModelSpec {
  const parsed = modelBimSchema.safeParse(input);
  if (!parsed.success) {
    throw new ModelError(
      "UNSUPPORTED_MODEL_BIM",
      "model.bim is outside the supported TMSL subset.",
      {
        issues: parsed.error.issues.map((entry) =>
          issue("INVALID_TMSL", entry.path.map(String).join("."), entry.message),
        ),
        cause: parsed.error,
      },
    );
  }
  const bim = parsed.data;
  const regularTables = bim.model.tables.filter((table) => table.calculationGroup === undefined);
  const calculationGroupTables = bim.model.tables.filter(
    (table) => table.calculationGroup !== undefined,
  );

  const spec = {
    compatibilityLevel: bim.compatibilityLevel,
    culture: bim.model.culture,
    ...(bim.model.sourceQueryCulture === undefined
      ? {}
      : { sourceQueryCulture: bim.model.sourceQueryCulture }),
    ...(bim.model.description === undefined ? {} : { description: bim.model.description }),
    defaultPowerBIDataSourceVersion: bim.model.defaultPowerBIDataSourceVersion,
    discourageImplicitMeasures: bim.model.discourageImplicitMeasures,
    dataAccessOptions: bim.model.dataAccessOptions,
    dataSources: bim.model.dataSources.map((source) => ({
      name: source.name,
      kind: "structured" as const,
      ...(source.description === undefined ? {} : { description: source.description }),
      connectionDetails: source.connectionDetails,
      ...(source.options === undefined ? {} : { options: source.options }),
      annotations: source.annotations,
    })),
    expressions: bim.model.expressions.map((expression) => ({
      name: expression.name,
      kind: "m" as const,
      expression: expressionText(expression.expression),
      ...(expression.description === undefined ? {} : { description: expression.description }),
      ...(expression.lineageTag === undefined ? {} : { lineageTag: expression.lineageTag }),
      annotations: expression.annotations,
    })),
    tables: regularTables.map((table) => ({
      name: table.name,
      ...(table.description === undefined ? {} : { description: table.description }),
      hidden: table.isHidden,
      columns: table.columns.map((column) =>
        column.type === "calculated"
          ? {
              kind: "calculated" as const,
              name: column.name,
              expression: expressionText(column.expression),
              dataType: column.dataType,
              ...(column.description === undefined ? {} : { description: column.description }),
              ...(column.formatString === undefined ? {} : { formatString: column.formatString }),
              hidden: column.isHidden,
              ...(column.sortByColumn === undefined ? {} : { sortByColumn: column.sortByColumn }),
              summarizeBy: column.summarizeBy,
              ...(column.isDefaultLabel === undefined
                ? {}
                : { isDefaultLabel: column.isDefaultLabel }),
              ...(column.isAvailableInMdx === undefined
                ? {}
                : { isAvailableInMdx: column.isAvailableInMdx }),
              ...(column.lineageTag === undefined ? {} : { lineageTag: column.lineageTag }),
              annotations: column.annotations,
            }
          : {
              kind: "source" as const,
              name: column.name,
              sourceColumn: column.sourceColumn,
              dataType: column.dataType,
              ...(column.description === undefined ? {} : { description: column.description }),
              ...(column.formatString === undefined ? {} : { formatString: column.formatString }),
              hidden: column.isHidden,
              key: column.isKey,
              ...(column.sortByColumn === undefined ? {} : { sortByColumn: column.sortByColumn }),
              summarizeBy: column.summarizeBy,
              ...(column.isDefaultLabel === undefined
                ? {}
                : { isDefaultLabel: column.isDefaultLabel }),
              ...(column.isAvailableInMdx === undefined
                ? {}
                : { isAvailableInMdx: column.isAvailableInMdx }),
              ...(column.lineageTag === undefined ? {} : { lineageTag: column.lineageTag }),
              annotations: column.annotations,
            },
      ),
      partitions: table.partitions.map((partition) => {
        switch (partition.source.type) {
          case "m":
            return {
              kind: "m" as const,
              name: partition.name,
              mode: partition.mode,
              expression: expressionText(partition.source.expression),
              annotations: partition.annotations,
            };
          case "query":
            return {
              kind: "query" as const,
              name: partition.name,
              mode: partition.mode,
              dataSourceName: partition.source.dataSource,
              query: expressionText(partition.source.query),
              annotations: partition.annotations,
            };
          case "entity":
            return {
              kind: "entity" as const,
              name: partition.name,
              mode: partition.mode,
              dataSourceName: partition.source.dataSource,
              entityName: partition.source.entityName,
              ...(partition.source.schemaName === undefined
                ? {}
                : { schemaName: partition.source.schemaName }),
              annotations: partition.annotations,
            };
          case "calculated":
            return {
              kind: "calculated" as const,
              name: partition.name,
              mode: "import" as const,
              expression: expressionText(partition.source.expression),
              annotations: partition.annotations,
            };
          case "calculationGroup":
            throw new ModelError(
              "UNSUPPORTED_CALCULATION_GROUP",
              `Regular table '${table.name}' cannot use a calculation-group partition.`,
            );
        }
      }),
      measures: table.measures.map((measure) => ({
        name: measure.name,
        expression: expressionText(measure.expression),
        description: measure.description,
        ...(measure.displayFolder === undefined ? {} : { displayFolder: measure.displayFolder }),
        formatString: measure.formatString,
        hidden: measure.isHidden,
        ...(measure.lineageTag === undefined ? {} : { lineageTag: measure.lineageTag }),
        annotations: measure.annotations,
      })),
      hierarchies: table.hierarchies.map((hierarchy) => ({
        name: hierarchy.name,
        ...(hierarchy.description === undefined ? {} : { description: hierarchy.description }),
        hidden: hierarchy.isHidden,
        levels: [...hierarchy.levels]
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((level) => ({
            name: level.name,
            column: level.column,
            ...(level.lineageTag === undefined ? {} : { lineageTag: level.lineageTag }),
          })),
        ...(hierarchy.lineageTag === undefined ? {} : { lineageTag: hierarchy.lineageTag }),
        annotations: hierarchy.annotations,
      })),
      ...(table.lineageTag === undefined ? {} : { lineageTag: table.lineageTag }),
      annotations: table.annotations,
    })),
    relationships: bim.model.relationships.map((relationship) => ({
      name: relationship.name,
      fromTable: relationship.fromTable,
      fromColumn: relationship.fromColumn,
      toTable: relationship.toTable,
      toColumn: relationship.toColumn,
      fromCardinality: relationship.fromCardinality,
      toCardinality: relationship.toCardinality,
      crossFilteringBehavior: relationship.crossFilteringBehavior,
      ...(relationship.securityFilteringBehavior === undefined
        ? {}
        : { securityFilteringBehavior: relationship.securityFilteringBehavior }),
      active: relationship.isActive,
      annotations: relationship.annotations,
    })),
    calculationGroups: calculationGroupTables
      .map((table) => {
        const group = table.calculationGroup;
        if (!group) {
          throw new ModelError(
            "UNSUPPORTED_MODEL_BIM",
            `Table '${table.name}' is missing a calculation group.`,
          );
        }
        const calculationGroupPartition = table.partitions[0];
        if (
          table.columns.length !== 1 ||
          table.columns[0]?.type === "calculated" ||
          table.partitions.length !== 1 ||
          calculationGroupPartition?.source.type !== "calculationGroup" ||
          calculationGroupPartition.mode !== "import" ||
          table.measures.length > 0 ||
          table.hierarchies.length > 0
        ) {
          throw new ModelError(
            "UNSUPPORTED_CALCULATION_GROUP",
            `Calculation group table '${table.name}' has unsupported companion objects.`,
          );
        }
        const column = table.columns[0];
        if (!column) {
          throw new ModelError(
            "UNSUPPORTED_CALCULATION_GROUP",
            `Calculation group table '${table.name}' is missing its calculation-group column.`,
          );
        }
        return {
          tableName: table.name,
          columnName: column.name,
          ...(table.description === undefined ? {} : { description: table.description }),
          precedence: group.precedence,
          calculationItems: group.calculationItems,
          ...(table.lineageTag === undefined ? {} : { lineageTag: table.lineageTag }),
          annotations: table.annotations,
          ...(column.lineageTag === undefined ? {} : { columnLineageTag: column.lineageTag }),
          columnAnnotations: column.annotations,
        };
      })
      .map((group) => ({
        tableName: group.tableName,
        columnName: group.columnName,
        ...(group.description === undefined ? {} : { description: group.description }),
        precedence: group.precedence,
        ...(group.lineageTag === undefined ? {} : { lineageTag: group.lineageTag }),
        annotations: group.annotations,
        ...(group.columnLineageTag === undefined
          ? {}
          : { columnLineageTag: group.columnLineageTag }),
        columnAnnotations: group.columnAnnotations,
        items: group.calculationItems.map((item) => ({
          name: item.name,
          expression: expressionText(item.expression),
          ...(item.description === undefined ? {} : { description: item.description }),
          ...(item.formatStringDefinition === undefined
            ? {}
            : { formatStringExpression: expressionText(item.formatStringDefinition.expression) }),
          ...(item.ordinal === undefined ? {} : { ordinal: item.ordinal }),
        })),
      })),
    roles: bim.model.roles.map((role) => ({
      name: role.name,
      ...(role.description === undefined ? {} : { description: role.description }),
      modelPermission: role.modelPermission,
      tablePermissions: role.tablePermissions.map((permission) => ({
        table: permission.name,
        filterExpression: expressionText(permission.filterExpression),
      })),
      annotations: role.annotations,
    })),
    annotations: bim.model.annotations,
  };
  return parseAndValidateModelSpec(spec);
}

const stableJson = (value: unknown): string =>
  `${JSON.stringify(canonicalizeJson(value), undefined, 2)}\n`;

export function buildTmslDefinition(
  input: unknown,
  definitionProperties: DefinitionPbism = DEFAULT_DEFINITION_PBISM,
  additionalParts: readonly SemanticModelDefinition["parts"][number][] = [],
): SemanticModelDefinition {
  const modelBim = modelSpecToBim(input);
  const pbism = definitionPbismSchema.parse(definitionProperties);
  const reservedPaths = new Set([MODEL_BIM_PATH, DEFINITION_PBISM_PATH]);
  const seenPaths = new Set<string>();
  const preservedParts = additionalParts.map((part) => {
    decodeDefinitionPart(part);
    if (
      reservedPaths.has(part.path) ||
      part.path.startsWith("definition/") ||
      seenPaths.has(part.path)
    ) {
      throw new ModelError(
        "INVALID_ADDITIONAL_DEFINITION_PART",
        `Additional definition part '${part.path}' conflicts with the TMSL definition.`,
      );
    }
    seenPaths.add(part.path);
    return { ...part };
  });
  preservedParts.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  return {
    format: "TMSL",
    parts: [
      encodeDefinitionPart(MODEL_BIM_PATH, stableJson(modelBim)),
      encodeDefinitionPart(DEFINITION_PBISM_PATH, stableJson(pbism)),
      ...preservedParts,
    ],
  };
}

export interface ParsedTmslDefinition {
  readonly model: ModelSpec;
  readonly modelBim: ModelBim;
  readonly definitionProperties: DefinitionPbism;
  readonly additionalParts: readonly SemanticModelDefinition["parts"][number][];
}

export function parseTmslDefinition(definition: SemanticModelDefinition): ParsedTmslDefinition {
  if (definition.format !== undefined && definition.format !== "TMSL") {
    throw new ModelError("UNSUPPORTED_DEFINITION_FORMAT", "Only TMSL definitions are supported.");
  }
  if (definition.parts.some((part) => part.path.startsWith("definition/"))) {
    throw new ModelError(
      "MIXED_DEFINITION_FORMAT",
      "TMSL model.bim parts cannot be combined with TMDL definition paths.",
    );
  }
  const byPath = new Map<string, SemanticModelDefinition["parts"][number]>();
  for (const part of definition.parts) {
    decodeDefinitionPart(part);
    if (byPath.has(part.path)) {
      throw new ModelError(
        "DUPLICATE_DEFINITION_PART",
        `Definition part '${part.path}' is duplicated.`,
      );
    }
    byPath.set(part.path, part);
  }
  const modelPart = byPath.get(MODEL_BIM_PATH);
  const propertiesPart = byPath.get(DEFINITION_PBISM_PATH);
  if (!modelPart || !propertiesPart) {
    throw new ModelError(
      "MISSING_DEFINITION_PART",
      `TMSL definitions require '${MODEL_BIM_PATH}' and '${DEFINITION_PBISM_PATH}'.`,
    );
  }
  const modelBimInput = parseJson(MODEL_BIM_PATH, decodeDefinitionPart(modelPart));
  const propertiesInput = parseJson(DEFINITION_PBISM_PATH, decodeDefinitionPart(propertiesPart));
  const modelBim = modelBimSchema.safeParse(modelBimInput);
  const properties = definitionPbismSchema.safeParse(propertiesInput);
  if (!modelBim.success || !properties.success) {
    const issues = [
      ...(modelBim.success
        ? []
        : modelBim.error.issues.map((entry) =>
            issue("INVALID_TMSL", entry.path.map(String).join("."), entry.message),
          )),
      ...(properties.success
        ? []
        : properties.error.issues.map((entry) =>
            issue("INVALID_PBISM", entry.path.map(String).join("."), entry.message),
          )),
    ];
    throw new ModelError("INVALID_DEFINITION", "The TMSL definition is invalid.", { issues });
  }
  return {
    model: bimToModelSpec(modelBim.data),
    modelBim: modelBim.data,
    definitionProperties: properties.data,
    additionalParts: definition.parts
      .filter((part) => part.path !== MODEL_BIM_PATH && part.path !== DEFINITION_PBISM_PATH)
      .map((part) => ({ ...part })),
  };
}
