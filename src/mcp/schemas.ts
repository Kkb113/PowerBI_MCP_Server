import { z } from "zod";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const fabricIdSchema = z.uuid().describe("Microsoft Fabric UUID.");
export const definitionHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 hash of the normalized model definition.");

const boundedNameSchema = z.string().trim().min(1).max(256);
const optionalDescriptionSchema = z.string().max(4_000).optional();

const sourceColumnSchema = z.object({
  kind: z.literal("source"),
  name: boundedNameSchema,
  sourceColumn: boundedNameSchema,
  dataType: z.enum(["string", "int64", "double", "decimal", "dateTime", "boolean", "binary"]),
  description: optionalDescriptionSchema,
  formatString: z.string().max(512).optional(),
  hidden: z.boolean().default(false),
  summarizeBy: z
    .enum(["none", "sum", "min", "max", "count", "average", "distinctCount"])
    .optional(),
});

const calculatedColumnSchema = z.object({
  kind: z.literal("calculated"),
  name: boundedNameSchema,
  expression: z.string().trim().min(1).max(100_000),
  dataType: z.enum(["string", "int64", "double", "decimal", "dateTime", "boolean"]),
  description: optionalDescriptionSchema,
  formatString: z.string().max(512).optional(),
  hidden: z.boolean().default(false),
});

const columnSchema = z.discriminatedUnion("kind", [sourceColumnSchema, calculatedColumnSchema]);

const mPartitionSchema = z.object({
  kind: z.literal("m"),
  name: boundedNameSchema,
  mode: z.enum(["import", "directQuery", "directLake"]),
  expression: z.string().trim().min(1).max(200_000),
});

const queryPartitionSchema = z.object({
  kind: z.literal("query"),
  name: boundedNameSchema,
  mode: z.enum(["import", "directQuery"]),
  dataSourceName: boundedNameSchema,
  query: z.string().trim().min(1).max(200_000),
});

const entityPartitionSchema = z.object({
  kind: z.literal("entity"),
  name: boundedNameSchema,
  mode: z.literal("directLake"),
  dataSourceName: boundedNameSchema,
  entityName: boundedNameSchema,
  schemaName: boundedNameSchema.optional(),
});

const calculatedPartitionSchema = z.object({
  kind: z.literal("calculated"),
  name: boundedNameSchema,
  mode: z.literal("import"),
  expression: z.string().trim().min(1).max(100_000),
});

const partitionSchema = z.discriminatedUnion("kind", [
  mPartitionSchema,
  queryPartitionSchema,
  entityPartitionSchema,
  calculatedPartitionSchema,
]);

const measureSchema = z.object({
  name: boundedNameSchema,
  expression: z.string().trim().min(1).max(100_000),
  description: optionalDescriptionSchema,
  displayFolder: z.string().max(512).optional(),
  formatString: z.string().max(512).optional(),
  hidden: z.boolean().default(false),
});

const hierarchySchema = z.object({
  name: boundedNameSchema,
  description: optionalDescriptionSchema,
  hidden: z.boolean().default(false),
  levels: z
    .array(
      z.object({
        name: boundedNameSchema,
        column: boundedNameSchema,
      }),
    )
    .min(1)
    .max(100),
});

const tableSchema = z.object({
  name: boundedNameSchema,
  description: optionalDescriptionSchema,
  hidden: z.boolean().default(false),
  columns: z.array(columnSchema).max(5_000).default([]),
  partitions: z.array(partitionSchema).max(100).default([]),
  measures: z.array(measureSchema).max(5_000).default([]),
  hierarchies: z.array(hierarchySchema).max(500).default([]),
});

const relationshipSchema = z.object({
  name: boundedNameSchema,
  fromTable: boundedNameSchema,
  fromColumn: boundedNameSchema,
  toTable: boundedNameSchema,
  toColumn: boundedNameSchema,
  fromCardinality: z.enum(["one", "many"]),
  toCardinality: z.enum(["one", "many"]),
  crossFilteringBehavior: z.enum(["oneDirection", "bothDirections"]).default("oneDirection"),
  active: z.boolean().default(true),
});

const calculationGroupSchema = z.object({
  tableName: boundedNameSchema,
  precedence: z.number().int().min(0).max(10_000).default(0),
  items: z
    .array(
      z.object({
        name: boundedNameSchema,
        expression: z.string().trim().min(1).max(100_000),
        description: optionalDescriptionSchema,
        ordinal: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(1_000),
});

const roleSchema = z.object({
  name: boundedNameSchema,
  modelPermission: z.literal("read").default("read"),
  tablePermissions: z
    .array(
      z.object({
        table: boundedNameSchema,
        filterExpression: z.string().trim().min(1).max(100_000),
      }),
    )
    .max(500)
    .default([]),
});

export const modelSpecSchema = z.object({
  compatibilityLevel: z.number().int().min(1_520).max(2_000).default(1_702),
  culture: z.string().trim().min(2).max(32).default("en-US"),
  description: optionalDescriptionSchema,
  tables: z.array(tableSchema).min(1).max(1_000),
  relationships: z.array(relationshipSchema).max(5_000).default([]),
  calculationGroups: z.array(calculationGroupSchema).max(100).default([]),
  expressions: z
    .array(
      z.object({
        name: boundedNameSchema,
        kind: z.literal("m"),
        expression: z.string().trim().min(1).max(200_000),
        description: optionalDescriptionSchema,
      }),
    )
    .max(1_000)
    .default([]),
  roles: z.array(roleSchema).max(500).default([]),
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

const objectSelectorSchema = z.object({
  objectType: modelObjectTypeSchema,
  name: boundedNameSchema,
  parentName: boundedNameSchema.optional(),
});

const objectValueSchema = z.record(z.string(), jsonValueSchema);

export const modelChangeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    target: objectSelectorSchema,
    value: objectValueSchema,
  }),
  z.object({
    action: z.literal("update"),
    target: objectSelectorSchema,
    value: objectValueSchema,
  }),
  z.object({
    action: z.literal("delete"),
    target: objectSelectorSchema,
  }),
  z.object({
    action: z.literal("rename"),
    target: objectSelectorSchema,
    newName: boundedNameSchema,
  }),
]);

export const toolOutputSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["success", "pending", "failed", "not_implemented"]),
  message: z.string(),
  data: z.record(z.string(), jsonValueSchema).nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
});
