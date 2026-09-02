import { extractDaxReferences } from "./dax.js";
import type { ModelReference } from "./errors.js";
import type { ModelObjectType, ModelSpec } from "./schemas.js";

export interface ModelTarget {
  readonly objectType: ModelObjectType;
  readonly name: string;
  readonly parentName?: string;
}

const canonicalName = (name: string): string => name.toLocaleLowerCase("en-US");
const sameName = (left: string | undefined, right: string | undefined): boolean =>
  left !== undefined && right !== undefined && canonicalName(left) === canonicalName(right);

const mReferencesName = (expression: string, name: string): boolean => {
  const escapedName = name.replaceAll('"', '""');
  const quoted = `#"${escapedName}"`;
  return expression.toLocaleLowerCase("en-US").includes(quoted.toLocaleLowerCase("en-US"));
};

export function findModelReferences(
  model: ModelSpec,
  target: ModelTarget,
): readonly ModelReference[] {
  const references: ModelReference[] = [];
  const seen = new Set<string>();
  const add = (objectType: ModelObjectType, path: string, property: string): void => {
    const key = `${objectType}:${path}:${property}`.toLocaleLowerCase("en-US");
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ objectType, path, property });
  };

  for (const table of model.tables) {
    for (const partition of table.partitions) {
      if (
        target.objectType === "data_source" &&
        (partition.kind === "query" || partition.kind === "entity") &&
        sameName(partition.dataSourceName, target.name)
      ) {
        add("partition", `${table.name}/${partition.name}`, "dataSourceName");
      }
      if (
        target.objectType === "expression" &&
        partition.kind === "m" &&
        mReferencesName(partition.expression, target.name)
      ) {
        add("partition", `${table.name}/${partition.name}`, "expression");
      }
    }
    for (const column of table.columns) {
      if (
        target.objectType === "column" &&
        sameName(table.name, target.parentName) &&
        sameName(column.sortByColumn, target.name) &&
        !sameName(column.name, target.name)
      ) {
        add("column", `${table.name}[${column.name}]`, "sortByColumn");
      }
    }
    for (const hierarchy of table.hierarchies) {
      if (
        target.objectType === "column" &&
        sameName(table.name, target.parentName) &&
        hierarchy.levels.some((level) => sameName(level.column, target.name))
      ) {
        add("hierarchy", `${table.name}/${hierarchy.name}`, "levels.column");
      }
    }
  }

  for (const relationship of model.relationships) {
    if (
      target.objectType === "table" &&
      (sameName(relationship.fromTable, target.name) || sameName(relationship.toTable, target.name))
    ) {
      add("relationship", relationship.name, "endpoint.table");
    }
    if (
      target.objectType === "column" &&
      ((sameName(relationship.fromTable, target.parentName) &&
        sameName(relationship.fromColumn, target.name)) ||
        (sameName(relationship.toTable, target.parentName) &&
          sameName(relationship.toColumn, target.name)))
    ) {
      add("relationship", relationship.name, "endpoint.column");
    }
  }

  for (const role of model.roles) {
    for (const permission of role.tablePermissions) {
      if (target.objectType === "table" && sameName(permission.table, target.name)) {
        add("role", role.name, `tablePermissions.${permission.table}`);
      }
    }
  }

  for (const expression of model.expressions) {
    if (
      target.objectType === "expression" &&
      !sameName(expression.name, target.name) &&
      mReferencesName(expression.expression, target.name)
    ) {
      add("expression", expression.name, "expression");
    }
  }

  const tableNames = [
    ...model.tables.map((table) => table.name),
    ...model.calculationGroups.map((group) => group.tableName),
  ];
  const inspectDax = (
    expression: string,
    objectType: ModelObjectType,
    path: string,
    property: string,
    ownerTable?: string,
    ownerName?: string,
  ): void => {
    for (const reference of extractDaxReferences(expression, tableNames)) {
      if (
        (target.objectType === "table" || target.objectType === "calculation_group") &&
        sameName(reference.table, target.name) &&
        !sameName(ownerTable, target.name)
      ) {
        add(objectType, path, property);
      }
      if (
        target.objectType === "column" &&
        ((reference.kind === "qualified" &&
          sameName(reference.table, target.parentName) &&
          sameName(reference.name, target.name)) ||
          (reference.kind === "unqualified" &&
            sameName(ownerTable, target.parentName) &&
            sameName(reference.name, target.name))) &&
        !(sameName(ownerTable, target.parentName) && sameName(ownerName, target.name))
      ) {
        add(objectType, path, property);
      }
      if (
        target.objectType === "measure" &&
        sameName(reference.name, target.name) &&
        (reference.kind === "unqualified" || sameName(reference.table, target.parentName)) &&
        !(sameName(ownerTable, target.parentName) && sameName(ownerName, target.name))
      ) {
        add(objectType, path, property);
      }
    }
  };

  for (const table of model.tables) {
    for (const column of table.columns) {
      if (column.kind === "calculated") {
        inspectDax(
          column.expression,
          "column",
          `${table.name}[${column.name}]`,
          "expression",
          table.name,
          column.name,
        );
      }
    }
    for (const measure of table.measures) {
      inspectDax(
        measure.expression,
        "measure",
        `${table.name}[${measure.name}]`,
        "expression",
        table.name,
        measure.name,
      );
    }
    for (const partition of table.partitions) {
      if (partition.kind === "calculated") {
        inspectDax(
          partition.expression,
          "partition",
          `${table.name}/${partition.name}`,
          "expression",
          table.name,
          partition.name,
        );
      }
    }
  }
  for (const group of model.calculationGroups) {
    for (const item of group.items) {
      inspectDax(
        item.expression,
        "calculation_item",
        `${group.tableName}/${item.name}`,
        "expression",
        group.tableName,
        item.name,
      );
      if (item.formatStringExpression) {
        inspectDax(
          item.formatStringExpression,
          "calculation_item",
          `${group.tableName}/${item.name}`,
          "formatStringExpression",
          group.tableName,
          item.name,
        );
      }
    }
  }
  for (const role of model.roles) {
    for (const permission of role.tablePermissions) {
      inspectDax(
        permission.filterExpression,
        "role",
        role.name,
        `tablePermissions.${permission.table}.filterExpression`,
        permission.table,
      );
    }
  }

  return references.sort(
    (left, right) =>
      left.objectType.localeCompare(right.objectType, "en-US") ||
      left.path.localeCompare(right.path, "en-US") ||
      left.property.localeCompare(right.property, "en-US"),
  );
}
