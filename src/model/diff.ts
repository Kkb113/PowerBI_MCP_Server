import { canonicalizeJson, normalizeModelSpec } from "./normalize.js";
import type { ModelObjectType, ModelSpec } from "./schemas.js";

export type DiffObjectType = "model" | ModelObjectType;
export type ChangeKind = "added" | "changed" | "deleted";

export interface SemanticChange {
  readonly kind: ChangeKind;
  readonly objectType: DiffObjectType;
  readonly path: string;
  readonly fields: readonly string[];
  readonly potentiallyBreaking: boolean;
}

export interface SemanticDiff {
  readonly hasChanges: boolean;
  readonly added: readonly SemanticChange[];
  readonly changed: readonly SemanticChange[];
  readonly deleted: readonly SemanticChange[];
  readonly potentiallyBreaking: readonly SemanticChange[];
  readonly totalChanges: number;
}

interface IndexedObject {
  readonly objectType: DiffObjectType;
  readonly path: string;
  readonly value: Readonly<Record<string, unknown>>;
}

const record = (value: object): Readonly<Record<string, unknown>> =>
  value as Readonly<Record<string, unknown>>;

const indexModel = (model: ModelSpec): ReadonlyMap<string, IndexedObject> => {
  const objects = new Map<string, IndexedObject>();
  const add = (
    objectType: DiffObjectType,
    path: string,
    value: Readonly<Record<string, unknown>>,
  ): void => {
    objects.set(`${objectType}:${path.toLocaleLowerCase("en-US")}`, {
      objectType,
      path,
      value,
    });
  };

  add("model", "model", {
    compatibilityLevel: model.compatibilityLevel,
    culture: model.culture,
    sourceQueryCulture: model.sourceQueryCulture,
    description: model.description,
    defaultPowerBIDataSourceVersion: model.defaultPowerBIDataSourceVersion,
    discourageImplicitMeasures: model.discourageImplicitMeasures,
    dataAccessOptions: model.dataAccessOptions,
    annotations: model.annotations,
  });
  for (const source of model.dataSources) add("data_source", source.name, record(source));
  for (const expression of model.expressions)
    add("expression", expression.name, record(expression));
  for (const table of model.tables) {
    add("table", table.name, {
      description: table.description,
      hidden: table.hidden,
      lineageTag: table.lineageTag,
      annotations: table.annotations,
    });
    for (const column of table.columns)
      add("column", `${table.name}[${column.name}]`, record(column));
    for (const partition of table.partitions)
      add("partition", `${table.name}/${partition.name}`, record(partition));
    for (const measure of table.measures)
      add("measure", `${table.name}[${measure.name}]`, record(measure));
    for (const hierarchy of table.hierarchies)
      add("hierarchy", `${table.name}/${hierarchy.name}`, record(hierarchy));
  }
  for (const relationship of model.relationships)
    add("relationship", relationship.name, record(relationship));
  for (const group of model.calculationGroups) {
    add("calculation_group", group.tableName, {
      columnName: group.columnName,
      description: group.description,
      precedence: group.precedence,
      lineageTag: group.lineageTag,
      annotations: group.annotations,
      columnLineageTag: group.columnLineageTag,
      columnAnnotations: group.columnAnnotations,
    });
    for (const item of group.items)
      add("calculation_item", `${group.tableName}/${item.name}`, record(item));
  }
  for (const role of model.roles) add("role", role.name, record(role));
  return objects;
};

const stableValue = (value: unknown): string => JSON.stringify(canonicalizeJson(value));

const changedFields = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): readonly string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => stableValue(before[key]) !== stableValue(after[key]))
    .sort((left, right) => left.localeCompare(right, "en-US"));

const cosmeticFields = new Set([
  "annotations",
  "columnAnnotations",
  "columnLineageTag",
  "description",
  "displayFolder",
  "formatString",
  "hidden",
  "isAvailableInMdx",
  "isDefaultLabel",
  "lineageTag",
]);

const breaking = (
  kind: ChangeKind,
  objectType: DiffObjectType,
  fields: readonly string[],
): boolean => {
  if (kind === "deleted") return true;
  if (kind === "added") return ["relationship", "role"].includes(objectType);
  if (
    ["model", "data_source", "expression", "partition", "relationship", "role"].includes(objectType)
  )
    return true;
  return fields.some((field) => !cosmeticFields.has(field));
};

export function diffModelSpecs(beforeInput: unknown, afterInput: unknown): SemanticDiff {
  const before = indexModel(normalizeModelSpec(beforeInput));
  const after = indexModel(normalizeModelSpec(afterInput));
  const added: SemanticChange[] = [];
  const changed: SemanticChange[] = [];
  const deleted: SemanticChange[] = [];

  for (const [key, object] of before) {
    const next = after.get(key);
    if (!next) {
      deleted.push({
        kind: "deleted",
        objectType: object.objectType,
        path: object.path,
        fields: [],
        potentiallyBreaking: true,
      });
      continue;
    }
    const fields = changedFields(object.value, next.value);
    if (fields.length > 0) {
      changed.push({
        kind: "changed",
        objectType: object.objectType,
        path: object.path,
        fields,
        potentiallyBreaking: breaking("changed", object.objectType, fields),
      });
    }
  }

  for (const [key, object] of after) {
    if (!before.has(key)) {
      added.push({
        kind: "added",
        objectType: object.objectType,
        path: object.path,
        fields: [],
        potentiallyBreaking: breaking("added", object.objectType, []),
      });
    }
  }

  const byPath = (left: SemanticChange, right: SemanticChange): number =>
    left.objectType.localeCompare(right.objectType, "en-US") ||
    left.path.localeCompare(right.path, "en-US");
  added.sort(byPath);
  changed.sort(byPath);
  deleted.sort(byPath);
  const potentiallyBreaking = [...added, ...changed, ...deleted]
    .filter((change) => change.potentiallyBreaking)
    .sort(byPath);

  return {
    hasChanges: added.length + changed.length + deleted.length > 0,
    added,
    changed,
    deleted,
    potentiallyBreaking,
    totalChanges: added.length + changed.length + deleted.length,
  };
}
