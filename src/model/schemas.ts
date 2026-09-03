import { z } from "zod";

export const boundedNameSchema = z.string().trim().min(1).max(256);
export const optionalDescriptionSchema = z.string().max(4_000).optional();
export const requiredDescriptionSchema = z.string().trim().min(1).max(4_000);
export const expressionSchema = z.string().trim().min(1).max(200_000);
export const dataTypeSchema = z.enum([
  "string",
  "int64",
  "double",
  "decimal",
  "dateTime",
  "boolean",
  "binary",
]);
export const summarizeBySchema = z.enum([
  "none",
  "sum",
  "min",
  "max",
  "count",
  "average",
  "distinctCount",
]);

// The description prevents Zod from collapsing this union into a multi-valued JSON Schema
// `type`, which is legal but not portable across all MCP clients. It emits explicit `anyOf` arms.
const simpleJsonValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().describe("String value."),
]);
const simpleJsonObjectSchema = z.record(z.string(), simpleJsonValueSchema);
export const annotationSchema = z.strictObject({
  name: boundedNameSchema,
  value: z.union([z.string(), z.array(z.string())]),
});
const annotationsSchema = z.array(annotationSchema).max(1_000).default([]);
const lineageTagSchema = z.uuid().optional();

export const dataSourceSchema = z.strictObject({
  name: boundedNameSchema,
  kind: z.literal("structured").default("structured"),
  description: optionalDescriptionSchema,
  connectionDetails: z.strictObject({
    protocol: z.string().trim().min(1).max(128),
    address: simpleJsonObjectSchema,
  }),
  options: simpleJsonObjectSchema.optional(),
  annotations: annotationsSchema,
});

export const sourceColumnSchema = z.strictObject({
  kind: z.literal("source"),
  name: boundedNameSchema,
  sourceColumn: boundedNameSchema,
  dataType: dataTypeSchema,
  description: optionalDescriptionSchema,
  formatString: z.string().trim().min(1).max(512).optional(),
  hidden: z.boolean().default(false),
  key: z.boolean().default(false),
  sortByColumn: boundedNameSchema.optional(),
  summarizeBy: summarizeBySchema.default("none"),
  isDefaultLabel: z.boolean().optional(),
  isAvailableInMdx: z.boolean().optional(),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

export const calculatedColumnSchema = z.strictObject({
  kind: z.literal("calculated"),
  name: boundedNameSchema,
  expression: expressionSchema,
  dataType: dataTypeSchema.exclude(["binary"]),
  description: optionalDescriptionSchema,
  formatString: z.string().trim().min(1).max(512).optional(),
  hidden: z.boolean().default(false),
  sortByColumn: boundedNameSchema.optional(),
  summarizeBy: summarizeBySchema.default("none"),
  isDefaultLabel: z.boolean().optional(),
  isAvailableInMdx: z.boolean().optional(),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

export const columnSchema = z.discriminatedUnion("kind", [
  sourceColumnSchema,
  calculatedColumnSchema,
]);

export const mPartitionSchema = z.strictObject({
  kind: z.literal("m"),
  name: boundedNameSchema,
  mode: z.enum(["import", "directQuery"]),
  expression: expressionSchema,
  annotations: annotationsSchema,
});

export const queryPartitionSchema = z.strictObject({
  kind: z.literal("query"),
  name: boundedNameSchema,
  mode: z.enum(["import", "directQuery"]),
  dataSourceName: boundedNameSchema,
  query: expressionSchema,
  annotations: annotationsSchema,
});

export const entityPartitionSchema = z.strictObject({
  kind: z.literal("entity"),
  name: boundedNameSchema,
  mode: z.literal("directLake"),
  dataSourceName: boundedNameSchema,
  entityName: boundedNameSchema,
  schemaName: boundedNameSchema.optional(),
  annotations: annotationsSchema,
});

export const calculatedPartitionSchema = z.strictObject({
  kind: z.literal("calculated"),
  name: boundedNameSchema,
  mode: z.literal("import"),
  expression: expressionSchema,
  annotations: annotationsSchema,
});

export const partitionSchema = z.discriminatedUnion("kind", [
  mPartitionSchema,
  queryPartitionSchema,
  entityPartitionSchema,
  calculatedPartitionSchema,
]);

export const measureSchema = z.strictObject({
  name: boundedNameSchema,
  expression: expressionSchema,
  description: requiredDescriptionSchema,
  displayFolder: z.string().trim().min(1).max(512).optional(),
  formatString: z.string().trim().min(1).max(512),
  hidden: z.boolean().default(false),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

export const hierarchySchema = z.strictObject({
  name: boundedNameSchema,
  description: optionalDescriptionSchema,
  hidden: z.boolean().default(false),
  levels: z
    .array(
      z.strictObject({
        name: boundedNameSchema,
        column: boundedNameSchema,
        lineageTag: lineageTagSchema,
      }),
    )
    .min(1)
    .max(100),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

export const tableSchema = z.strictObject({
  name: boundedNameSchema,
  description: optionalDescriptionSchema,
  hidden: z.boolean().default(false),
  columns: z.array(columnSchema).max(5_000).default([]),
  partitions: z.array(partitionSchema).max(1_000).default([]),
  measures: z.array(measureSchema).max(5_000).default([]),
  hierarchies: z.array(hierarchySchema).max(500).default([]),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

export const relationshipSchema = z.strictObject({
  name: boundedNameSchema,
  fromTable: boundedNameSchema,
  fromColumn: boundedNameSchema,
  toTable: boundedNameSchema,
  toColumn: boundedNameSchema,
  fromCardinality: z.enum(["one", "many"]),
  toCardinality: z.enum(["one", "many"]),
  crossFilteringBehavior: z
    .enum(["oneDirection", "bothDirections", "automatic"])
    .default("oneDirection"),
  securityFilteringBehavior: z.enum(["oneDirection", "bothDirections"]).optional(),
  active: z.boolean().default(true),
  annotations: annotationsSchema,
});

export const calculationItemSchema = z.strictObject({
  name: boundedNameSchema,
  expression: expressionSchema,
  description: optionalDescriptionSchema,
  formatStringExpression: expressionSchema.optional(),
  ordinal: z.number().int().min(0).optional(),
});

export const calculationGroupSchema = z.strictObject({
  tableName: boundedNameSchema,
  columnName: boundedNameSchema.default("Name"),
  description: optionalDescriptionSchema,
  precedence: z.number().int().min(0).max(10_000).default(0),
  items: z.array(calculationItemSchema).min(1).max(1_000),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
  columnLineageTag: lineageTagSchema,
  columnAnnotations: annotationsSchema,
});

export const namedExpressionSchema = z.strictObject({
  name: boundedNameSchema,
  kind: z.literal("m"),
  expression: expressionSchema,
  description: optionalDescriptionSchema,
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

export const roleSchema = z.strictObject({
  name: boundedNameSchema,
  description: optionalDescriptionSchema,
  modelPermission: z.literal("read").default("read"),
  tablePermissions: z
    .array(
      z.strictObject({
        table: boundedNameSchema,
        filterExpression: expressionSchema,
      }),
    )
    .max(500)
    .default([]),
  annotations: annotationsSchema,
});

export const modelSpecSchema = z.strictObject({
  compatibilityLevel: z.number().int().min(1_520).max(2_000).default(1_702),
  culture: z.string().trim().min(2).max(32).default("en-US"),
  sourceQueryCulture: z.string().trim().min(2).max(32).optional(),
  description: optionalDescriptionSchema,
  defaultPowerBIDataSourceVersion: z.literal("powerBI_V3").default("powerBI_V3"),
  discourageImplicitMeasures: z.boolean().default(true),
  dataAccessOptions: z
    .strictObject({
      legacyRedirects: z.boolean().default(true),
      returnErrorValuesAsNull: z.boolean().default(true),
    })
    .default({ legacyRedirects: true, returnErrorValuesAsNull: true }),
  dataSources: z.array(dataSourceSchema).max(100).default([]),
  tables: z.array(tableSchema).min(1).max(1_000),
  relationships: z.array(relationshipSchema).max(5_000).default([]),
  calculationGroups: z.array(calculationGroupSchema).max(100).default([]),
  expressions: z.array(namedExpressionSchema).max(1_000).default([]),
  roles: z.array(roleSchema).max(500).default([]),
  annotations: annotationsSchema,
});

export const modelObjectTypeSchema = z.enum([
  "expression",
  "data_source",
  "table",
  "column",
  "partition",
  "measure",
  "relationship",
  "hierarchy",
  "calculation_group",
  "calculation_item",
  "role",
]);

const modelSelector = <T extends z.ZodLiteral>(objectType: T) =>
  z.strictObject({ objectType, name: boundedNameSchema });
const childSelector = <T extends z.ZodLiteral>(objectType: T) =>
  z.strictObject({ objectType, name: boundedNameSchema, parentName: boundedNameSchema });

const targetValueSchema = z.union([
  z.strictObject({ target: modelSelector(z.literal("expression")), value: namedExpressionSchema }),
  z.strictObject({ target: modelSelector(z.literal("data_source")), value: dataSourceSchema }),
  z.strictObject({ target: modelSelector(z.literal("table")), value: tableSchema }),
  z.strictObject({ target: childSelector(z.literal("column")), value: columnSchema }),
  z.strictObject({ target: childSelector(z.literal("partition")), value: partitionSchema }),
  z.strictObject({ target: childSelector(z.literal("measure")), value: measureSchema }),
  z.strictObject({ target: modelSelector(z.literal("relationship")), value: relationshipSchema }),
  z.strictObject({ target: childSelector(z.literal("hierarchy")), value: hierarchySchema }),
  z.strictObject({
    target: modelSelector(z.literal("calculation_group")),
    value: calculationGroupSchema,
  }),
  z.strictObject({
    target: childSelector(z.literal("calculation_item")),
    value: calculationItemSchema,
  }),
  z.strictObject({ target: modelSelector(z.literal("role")), value: roleSchema }),
]);

const targetSchema = z.union([
  modelSelector(z.literal("expression")),
  modelSelector(z.literal("data_source")),
  modelSelector(z.literal("table")),
  childSelector(z.literal("column")),
  childSelector(z.literal("partition")),
  childSelector(z.literal("measure")),
  modelSelector(z.literal("relationship")),
  childSelector(z.literal("hierarchy")),
  modelSelector(z.literal("calculation_group")),
  childSelector(z.literal("calculation_item")),
  modelSelector(z.literal("role")),
]);

export const modelChangeSchema = z.union([
  z.strictObject({ action: z.literal("create") }).and(targetValueSchema),
  z.strictObject({ action: z.literal("update") }).and(targetValueSchema),
  z.strictObject({ action: z.literal("delete"), target: targetSchema }),
  z.strictObject({
    action: z.literal("rename"),
    target: targetSchema,
    newName: boundedNameSchema,
  }),
]);

const expressionTextSchema = z.union([expressionSchema, z.array(z.string()).min(1).max(10_000)]);
const tmslDataSourceSchema = z.strictObject({
  type: z.literal("structured"),
  name: boundedNameSchema,
  description: optionalDescriptionSchema,
  connectionDetails: z.strictObject({
    protocol: z.string().trim().min(1),
    address: simpleJsonObjectSchema,
  }),
  options: simpleJsonObjectSchema.optional(),
  annotations: annotationsSchema,
});

const tmslColumnBase = {
  name: boundedNameSchema,
  dataType: dataTypeSchema,
  description: optionalDescriptionSchema,
  formatString: z.string().trim().min(1).max(512).optional(),
  isHidden: z.boolean().default(false),
  sortByColumn: boundedNameSchema.optional(),
  summarizeBy: summarizeBySchema.default("none"),
  isDefaultLabel: z.boolean().optional(),
  isAvailableInMdx: z.boolean().optional(),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
};

const tmslSourceColumnSchema = z.strictObject({
  ...tmslColumnBase,
  type: z.literal("data").optional(),
  sourceColumn: boundedNameSchema,
  isKey: z.boolean().default(false),
});

const tmslCalculatedColumnSchema = z.strictObject({
  ...tmslColumnBase,
  type: z.literal("calculated"),
  expression: expressionTextSchema,
});

const tmslPartitionSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("m"), expression: expressionTextSchema }),
  z.strictObject({
    type: z.literal("query"),
    query: expressionTextSchema,
    dataSource: boundedNameSchema,
  }),
  z.strictObject({
    type: z.literal("entity"),
    entityName: boundedNameSchema,
    schemaName: boundedNameSchema.optional(),
    dataSource: boundedNameSchema,
  }),
  z.strictObject({ type: z.literal("calculated"), expression: expressionTextSchema }),
  z.strictObject({ type: z.literal("calculationGroup") }),
]);

const tmslPartitionSchema = z
  .strictObject({
    name: boundedNameSchema,
    mode: z.enum(["import", "directQuery", "directLake"]),
    source: tmslPartitionSourceSchema,
    annotations: annotationsSchema,
  })
  .superRefine((partition, context) => {
    const validMode =
      (partition.source.type === "entity" && partition.mode === "directLake") ||
      (partition.source.type === "calculated" && partition.mode === "import") ||
      (partition.source.type === "calculationGroup" && partition.mode === "import") ||
      ((partition.source.type === "m" || partition.source.type === "query") &&
        (partition.mode === "import" || partition.mode === "directQuery"));
    if (!validMode) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: `Mode '${partition.mode}' is incompatible with '${partition.source.type}' partition source.`,
      });
    }
  });

const tmslMeasureSchema = z.strictObject({
  name: boundedNameSchema,
  expression: expressionTextSchema,
  description: requiredDescriptionSchema,
  displayFolder: z.string().trim().min(1).max(512).optional(),
  formatString: z.string().trim().min(1).max(512),
  isHidden: z.boolean().default(false),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

const tmslHierarchySchema = z.strictObject({
  name: boundedNameSchema,
  description: optionalDescriptionSchema,
  isHidden: z.boolean().default(false),
  levels: z
    .array(
      z.strictObject({
        name: boundedNameSchema,
        column: boundedNameSchema,
        ordinal: z.number().int().min(0),
        lineageTag: lineageTagSchema,
      }),
    )
    .min(1),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

const tmslCalculationItemSchema = z.strictObject({
  name: boundedNameSchema,
  expression: expressionTextSchema,
  description: optionalDescriptionSchema,
  formatStringDefinition: z.strictObject({ expression: expressionTextSchema }).optional(),
  ordinal: z.number().int().min(0).optional(),
});

const tmslCalculationGroupSchema = z.strictObject({
  precedence: z.number().int().min(0).max(10_000).default(0),
  calculationItems: z.array(tmslCalculationItemSchema).min(1),
});

const tmslTableSchema = z.strictObject({
  name: boundedNameSchema,
  description: optionalDescriptionSchema,
  isHidden: z.boolean().default(false),
  columns: z.array(z.union([tmslSourceColumnSchema, tmslCalculatedColumnSchema])).default([]),
  partitions: z.array(tmslPartitionSchema).default([]),
  measures: z.array(tmslMeasureSchema).default([]),
  hierarchies: z.array(tmslHierarchySchema).default([]),
  calculationGroup: tmslCalculationGroupSchema.optional(),
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

const tmslRelationshipSchema = z.strictObject({
  name: boundedNameSchema,
  type: z.literal("singleColumn").default("singleColumn"),
  fromTable: boundedNameSchema,
  fromColumn: boundedNameSchema,
  toTable: boundedNameSchema,
  toColumn: boundedNameSchema,
  fromCardinality: z.enum(["one", "many"]).default("many"),
  toCardinality: z.enum(["one", "many"]).default("one"),
  crossFilteringBehavior: z
    .enum(["oneDirection", "bothDirections", "automatic"])
    .default("oneDirection"),
  securityFilteringBehavior: z.enum(["oneDirection", "bothDirections"]).optional(),
  isActive: z.boolean().default(true),
  annotations: annotationsSchema,
});

const tmslExpressionSchema = z.strictObject({
  name: boundedNameSchema,
  kind: z.literal("m"),
  expression: expressionTextSchema,
  description: optionalDescriptionSchema,
  lineageTag: lineageTagSchema,
  annotations: annotationsSchema,
});

const tmslRoleSchema = z.strictObject({
  name: boundedNameSchema,
  description: optionalDescriptionSchema,
  modelPermission: z.literal("read"),
  tablePermissions: z
    .array(
      z.strictObject({
        name: boundedNameSchema,
        filterExpression: expressionTextSchema,
      }),
    )
    .default([]),
  annotations: annotationsSchema,
});

export const modelBimSchema = z.strictObject({
  compatibilityLevel: z.number().int().min(1_520).max(2_000),
  model: z.strictObject({
    culture: z.string().trim().min(2).max(32),
    sourceQueryCulture: z.string().trim().min(2).max(32).optional(),
    description: optionalDescriptionSchema,
    defaultPowerBIDataSourceVersion: z.literal("powerBI_V3").default("powerBI_V3"),
    discourageImplicitMeasures: z.boolean().default(true),
    dataAccessOptions: z
      .strictObject({
        legacyRedirects: z.boolean().default(true),
        returnErrorValuesAsNull: z.boolean().default(true),
      })
      .default({ legacyRedirects: true, returnErrorValuesAsNull: true }),
    dataSources: z.array(tmslDataSourceSchema).default([]),
    expressions: z.array(tmslExpressionSchema).default([]),
    tables: z.array(tmslTableSchema).min(1),
    relationships: z.array(tmslRelationshipSchema).default([]),
    roles: z.array(tmslRoleSchema).default([]),
    cultures: z.array(z.never()).max(0).default([]),
    functions: z.array(z.never()).max(0).default([]),
    perspectives: z.array(z.never()).max(0).default([]),
    annotations: annotationsSchema,
  }),
});

export const definitionPbismSchema = z.strictObject({
  $schema: z.literal(
    "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",
  ),
  version: z.string().regex(/^\d{1,3}\.\d{1,3}$/u),
  settings: z.strictObject({ qnaEnabled: z.boolean().default(false) }),
});

export type DataSourceSpec = z.infer<typeof dataSourceSchema>;
export type ColumnSpec = z.infer<typeof columnSchema>;
export type PartitionSpec = z.infer<typeof partitionSchema>;
export type MeasureSpec = z.infer<typeof measureSchema>;
export type HierarchySpec = z.infer<typeof hierarchySchema>;
export type TableSpec = z.infer<typeof tableSchema>;
export type RelationshipSpec = z.infer<typeof relationshipSchema>;
export type CalculationItemSpec = z.infer<typeof calculationItemSchema>;
export type CalculationGroupSpec = z.infer<typeof calculationGroupSchema>;
export type NamedExpressionSpec = z.infer<typeof namedExpressionSchema>;
export type RoleSpec = z.infer<typeof roleSchema>;
export type ModelSpec = z.infer<typeof modelSpecSchema>;
export type ModelChange = z.infer<typeof modelChangeSchema>;
export type ModelObjectType = z.infer<typeof modelObjectTypeSchema>;
export type ModelBim = z.infer<typeof modelBimSchema>;
export type DefinitionPbism = z.infer<typeof definitionPbismSchema>;
