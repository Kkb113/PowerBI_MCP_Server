import type { z } from "zod";
import { extractDaxReferences } from "./dax.js";
import { ModelError, type ModelIssue } from "./errors.js";
import {
  modelSpecSchema,
  type CalculationGroupSpec,
  type ModelSpec,
  type TableSpec,
} from "./schemas.js";

const canonicalName = (name: string): string => name.toLocaleLowerCase("en-US");

const issue = (code: string, path: string, message: string): ModelIssue => ({
  code,
  path,
  message,
});

const duplicateNameIssues = <T extends { readonly name: string }>(
  values: readonly T[],
  path: string,
): ModelIssue[] => {
  const seen = new Map<string, string>();
  const issues: ModelIssue[] = [];
  for (const [index, value] of values.entries()) {
    const canonical = canonicalName(value.name);
    const earlier = seen.get(canonical);
    if (earlier) {
      issues.push(
        issue(
          "DUPLICATE_NAME",
          `${path}[${index}].name`,
          `'${value.name}' conflicts with '${earlier}' using case-insensitive model naming.`,
        ),
      );
    } else {
      seen.set(canonical, value.name);
    }
  }
  return issues;
};

const tableIndex = (model: ModelSpec): ReadonlyMap<string, TableSpec> =>
  new Map(model.tables.map((table) => [canonicalName(table.name), table]));

const calculationGroupIndex = (model: ModelSpec): ReadonlyMap<string, CalculationGroupSpec> =>
  new Map(model.calculationGroups.map((group) => [canonicalName(group.tableName), group]));

const columnExists = (table: TableSpec | undefined, columnName: string): boolean =>
  table?.columns.some((column) => canonicalName(column.name) === canonicalName(columnName)) ??
  false;

const schemaIssues = (error: z.ZodError): readonly ModelIssue[] =>
  error.issues.map((entry) =>
    issue("INVALID_SCHEMA", entry.path.map(String).join("."), entry.message),
  );

const validateDaxReferences = (model: ModelSpec, issues: ModelIssue[]): void => {
  const tables = tableIndex(model);
  const allTableNames = [
    ...model.tables.map((table) => table.name),
    ...model.calculationGroups.map((group) => group.tableName),
  ];
  const measures = new Map<string, string>();
  for (const table of model.tables) {
    for (const measure of table.measures) {
      measures.set(canonicalName(measure.name), `${table.name}[${measure.name}]`);
    }
  }

  const inspect = (
    expression: string,
    path: string,
    currentTable?: TableSpec,
    unqualifiedColumnsAllowed = false,
  ): void => {
    for (const reference of extractDaxReferences(expression, allTableNames)) {
      if (reference.kind === "unqualified" && reference.name) {
        const validMeasure = measures.has(canonicalName(reference.name));
        const validColumn = unqualifiedColumnsAllowed && columnExists(currentTable, reference.name);
        if (!validMeasure && !validColumn) {
          issues.push(
            issue(
              "MISSING_DAX_REFERENCE",
              path,
              `DAX reference '[${reference.name}]' does not match a known measure${
                unqualifiedColumnsAllowed ? " or current-table column" : ""
              }.`,
            ),
          );
        }
        continue;
      }

      if (!reference.table) continue;
      const table = tables.get(canonicalName(reference.table));
      const calculationGroup = calculationGroupIndex(model).get(canonicalName(reference.table));
      if (!table && !calculationGroup) {
        issues.push(
          issue(
            "MISSING_DAX_REFERENCE",
            path,
            `DAX references missing table '${reference.table}'.`,
          ),
        );
      } else if (
        reference.kind === "qualified" &&
        reference.name &&
        table &&
        !columnExists(table, reference.name) &&
        !table.measures.some(
          (measure) => canonicalName(measure.name) === canonicalName(reference.name ?? ""),
        )
      ) {
        issues.push(
          issue(
            "MISSING_DAX_REFERENCE",
            path,
            `DAX references missing object '${reference.table}[${reference.name}]'.`,
          ),
        );
      } else if (
        reference.kind === "qualified" &&
        reference.name &&
        calculationGroup &&
        canonicalName(reference.name) !==
          canonicalName(calculationGroup.columnName ?? calculationGroup.tableName)
      ) {
        issues.push(
          issue(
            "MISSING_DAX_REFERENCE",
            path,
            `DAX references missing calculation-group column '${reference.table}[${reference.name}]'.`,
          ),
        );
      }
    }
  };

  for (const table of model.tables) {
    for (const column of table.columns) {
      if (column.kind === "calculated") {
        inspect(
          column.expression,
          `tables.${table.name}.columns.${column.name}.expression`,
          table,
          true,
        );
      }
    }
    for (const measure of table.measures) {
      inspect(measure.expression, `tables.${table.name}.measures.${measure.name}.expression`);
    }
    for (const partition of table.partitions) {
      if (partition.kind === "calculated") {
        inspect(
          partition.expression,
          `tables.${table.name}.partitions.${partition.name}.expression`,
        );
      }
    }
  }

  for (const group of model.calculationGroups) {
    for (const item of group.items) {
      inspect(
        item.expression,
        `calculationGroups.${group.tableName}.items.${item.name}.expression`,
      );
      if (item.formatStringExpression) {
        inspect(
          item.formatStringExpression,
          `calculationGroups.${group.tableName}.items.${item.name}.formatStringExpression`,
        );
      }
    }
  }

  for (const role of model.roles) {
    for (const permission of role.tablePermissions) {
      inspect(
        permission.filterExpression,
        `roles.${role.name}.tablePermissions.${permission.table}.filterExpression`,
        tables.get(canonicalName(permission.table)),
        true,
      );
    }
  }
};

const validateMeasureCycles = (model: ModelSpec, issues: ModelIssue[]): void => {
  const allTableNames = model.tables.map((table) => table.name);
  const measureOwners = new Map<string, string>();
  const measureTables = new Map<string, string>();
  const expressions = new Map<string, string>();
  for (const table of model.tables) {
    for (const measure of table.measures) {
      const name = canonicalName(measure.name);
      measureOwners.set(name, `${table.name}[${measure.name}]`);
      measureTables.set(name, canonicalName(table.name));
      expressions.set(name, measure.expression);
    }
  }

  const graph = new Map<string, Set<string>>();
  for (const [measure, expression] of expressions) {
    const dependencies = new Set<string>();
    for (const reference of extractDaxReferences(expression, allTableNames)) {
      if (reference.name) {
        const dependency = canonicalName(reference.name);
        const isMeasure = measureOwners.has(dependency);
        const isUnqualified = reference.kind === "unqualified";
        const isQualifiedMeasure =
          reference.kind === "qualified" &&
          reference.table !== undefined &&
          measureTables.get(dependency) === canonicalName(reference.table);
        if (isMeasure && (isUnqualified || isQualifiedMeasure)) {
          dependencies.add(dependency);
        }
      }
    }
    graph.set(measure, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reported = new Set<string>();
  const visit = (measure: string): void => {
    if (visited.has(measure)) return;
    if (visiting.has(measure)) {
      if (!reported.has(measure)) {
        reported.add(measure);
        issues.push(
          issue(
            "CIRCULAR_MEASURE_DEPENDENCY",
            `measures.${measureOwners.get(measure) ?? measure}`,
            `Measure '${measureOwners.get(measure) ?? measure}' participates in a circular dependency.`,
          ),
        );
      }
      return;
    }
    visiting.add(measure);
    for (const dependency of graph.get(measure) ?? []) visit(dependency);
    visiting.delete(measure);
    visited.add(measure);
  };
  for (const measure of graph.keys()) visit(measure);
};

const validateAnnotationNames = (model: ModelSpec, issues: ModelIssue[]): void => {
  const inspect = (annotations: ModelSpec["annotations"], path: string): void => {
    issues.push(...duplicateNameIssues(annotations, path));
  };
  inspect(model.annotations, "annotations");
  for (const source of model.dataSources)
    inspect(source.annotations, `dataSources.${source.name}.annotations`);
  for (const expression of model.expressions) {
    inspect(expression.annotations, `expressions.${expression.name}.annotations`);
  }
  for (const table of model.tables) {
    inspect(table.annotations, `tables.${table.name}.annotations`);
    for (const column of table.columns) {
      inspect(column.annotations, `tables.${table.name}.columns.${column.name}.annotations`);
    }
    for (const partition of table.partitions) {
      inspect(
        partition.annotations,
        `tables.${table.name}.partitions.${partition.name}.annotations`,
      );
    }
    for (const measure of table.measures) {
      inspect(measure.annotations, `tables.${table.name}.measures.${measure.name}.annotations`);
    }
    for (const hierarchy of table.hierarchies) {
      inspect(
        hierarchy.annotations,
        `tables.${table.name}.hierarchies.${hierarchy.name}.annotations`,
      );
    }
  }
  for (const relationship of model.relationships) {
    inspect(relationship.annotations, `relationships.${relationship.name}.annotations`);
  }
  for (const group of model.calculationGroups) {
    inspect(group.annotations, `calculationGroups.${group.tableName}.annotations`);
    inspect(group.columnAnnotations, `calculationGroups.${group.tableName}.columnAnnotations`);
  }
  for (const role of model.roles) inspect(role.annotations, `roles.${role.name}.annotations`);
};

export function validateModelSpec(model: ModelSpec): readonly ModelIssue[] {
  const issues: ModelIssue[] = [];
  validateAnnotationNames(model, issues);
  issues.push(...duplicateNameIssues(model.dataSources, "dataSources"));
  issues.push(...duplicateNameIssues(model.tables, "tables"));
  issues.push(...duplicateNameIssues(model.expressions, "expressions"));
  issues.push(...duplicateNameIssues(model.relationships, "relationships"));
  issues.push(...duplicateNameIssues(model.roles, "roles"));

  const tables = tableIndex(model);
  const dataSources = new Set(model.dataSources.map((source) => canonicalName(source.name)));
  const modelTableNames = new Map(
    model.tables.map((table) => [canonicalName(table.name), table.name]),
  );
  for (const [index, group] of model.calculationGroups.entries()) {
    const conflictingTable = modelTableNames.get(canonicalName(group.tableName));
    if (conflictingTable) {
      issues.push(
        issue(
          "DUPLICATE_NAME",
          `calculationGroups[${index}].tableName`,
          `Calculation group table '${group.tableName}' conflicts with table '${conflictingTable}'.`,
        ),
      );
    }
  }
  const groupNames = model.calculationGroups.map((group) => ({ name: group.tableName }));
  issues.push(...duplicateNameIssues(groupNames, "calculationGroups"));

  const allMeasures: Array<{ name: string }> = [];
  for (const [tablePosition, table] of model.tables.entries()) {
    const tablePath = `tables[${tablePosition}]`;
    issues.push(...duplicateNameIssues(table.columns, `${tablePath}.columns`));
    issues.push(...duplicateNameIssues(table.partitions, `${tablePath}.partitions`));
    issues.push(...duplicateNameIssues(table.measures, `${tablePath}.measures`));
    issues.push(...duplicateNameIssues(table.hierarchies, `${tablePath}.hierarchies`));
    allMeasures.push(...table.measures);

    for (const [columnPosition, column] of table.columns.entries()) {
      if (column.sortByColumn) {
        if (!columnExists(table, column.sortByColumn)) {
          issues.push(
            issue(
              "MISSING_COLUMN",
              `${tablePath}.columns[${columnPosition}].sortByColumn`,
              `Sort-by column '${column.sortByColumn}' does not exist in table '${table.name}'.`,
            ),
          );
        } else if (canonicalName(column.sortByColumn) === canonicalName(column.name)) {
          issues.push(
            issue(
              "SELF_REFERENCE",
              `${tablePath}.columns[${columnPosition}].sortByColumn`,
              "A column cannot sort by itself.",
            ),
          );
        }
      }
    }

    for (const [partitionPosition, partition] of table.partitions.entries()) {
      if (
        (partition.kind === "query" || partition.kind === "entity") &&
        !dataSources.has(canonicalName(partition.dataSourceName))
      ) {
        issues.push(
          issue(
            "MISSING_DATA_SOURCE",
            `${tablePath}.partitions[${partitionPosition}].dataSourceName`,
            `Partition references missing data source '${partition.dataSourceName}'.`,
          ),
        );
      }
    }

    for (const [hierarchyPosition, hierarchy] of table.hierarchies.entries()) {
      issues.push(
        ...duplicateNameIssues(
          hierarchy.levels,
          `${tablePath}.hierarchies[${hierarchyPosition}].levels`,
        ),
      );
      for (const [levelPosition, level] of hierarchy.levels.entries()) {
        if (!columnExists(table, level.column)) {
          issues.push(
            issue(
              "MISSING_COLUMN",
              `${tablePath}.hierarchies[${hierarchyPosition}].levels[${levelPosition}].column`,
              `Hierarchy level references missing column '${table.name}[${level.column}]'.`,
            ),
          );
        }
      }
    }
  }
  issues.push(...duplicateNameIssues(allMeasures, "measures"));

  for (const [relationshipPosition, relationship] of model.relationships.entries()) {
    const relationshipPath = `relationships[${relationshipPosition}]`;
    const fromTable = tables.get(canonicalName(relationship.fromTable));
    const toTable = tables.get(canonicalName(relationship.toTable));
    if (!fromTable) {
      issues.push(
        issue(
          "MISSING_TABLE",
          `${relationshipPath}.fromTable`,
          `Relationship references missing table '${relationship.fromTable}'.`,
        ),
      );
    } else if (!columnExists(fromTable, relationship.fromColumn)) {
      issues.push(
        issue(
          "MISSING_COLUMN",
          `${relationshipPath}.fromColumn`,
          `Relationship references missing column '${relationship.fromTable}[${relationship.fromColumn}]'.`,
        ),
      );
    }
    if (!toTable) {
      issues.push(
        issue(
          "MISSING_TABLE",
          `${relationshipPath}.toTable`,
          `Relationship references missing table '${relationship.toTable}'.`,
        ),
      );
    } else if (!columnExists(toTable, relationship.toColumn)) {
      issues.push(
        issue(
          "MISSING_COLUMN",
          `${relationshipPath}.toColumn`,
          `Relationship references missing column '${relationship.toTable}[${relationship.toColumn}]'.`,
        ),
      );
    }
    if (
      canonicalName(relationship.fromTable) === canonicalName(relationship.toTable) &&
      canonicalName(relationship.fromColumn) === canonicalName(relationship.toColumn)
    ) {
      issues.push(
        issue(
          "SELF_REFERENCE",
          relationshipPath,
          "A relationship cannot connect a column to itself.",
        ),
      );
    }
  }

  for (const [groupPosition, group] of model.calculationGroups.entries()) {
    issues.push(...duplicateNameIssues(group.items, `calculationGroups[${groupPosition}].items`));
    const ordinals = new Set<number>();
    for (const [itemPosition, item] of group.items.entries()) {
      if (item.ordinal !== undefined) {
        if (ordinals.has(item.ordinal)) {
          issues.push(
            issue(
              "DUPLICATE_ORDINAL",
              `calculationGroups[${groupPosition}].items[${itemPosition}].ordinal`,
              `Calculation item ordinal ${item.ordinal} is duplicated.`,
            ),
          );
        }
        ordinals.add(item.ordinal);
      }
    }
  }

  for (const [rolePosition, role] of model.roles.entries()) {
    const permissions = role.tablePermissions.map((permission) => ({ name: permission.table }));
    issues.push(...duplicateNameIssues(permissions, `roles[${rolePosition}].tablePermissions`));
    for (const [permissionPosition, permission] of role.tablePermissions.entries()) {
      if (!tables.has(canonicalName(permission.table))) {
        issues.push(
          issue(
            "MISSING_TABLE",
            `roles[${rolePosition}].tablePermissions[${permissionPosition}].table`,
            `Role permission references missing table '${permission.table}'.`,
          ),
        );
      }
    }
  }

  validateDaxReferences(model, issues);
  validateMeasureCycles(model, issues);
  return issues;
}

export function parseAndValidateModelSpec(input: unknown): ModelSpec {
  const parsed = modelSpecSchema.safeParse(input);
  if (!parsed.success) {
    const issues = schemaIssues(parsed.error);
    throw new ModelError("MODEL_SCHEMA_INVALID", "The model does not match the ModelSpec schema.", {
      issues,
      cause: parsed.error,
    });
  }
  const issues = validateModelSpec(parsed.data);
  if (issues.length > 0) {
    throw new ModelError("MODEL_VALIDATION_FAILED", "The model violates semantic invariants.", {
      issues,
    });
  }
  return parsed.data;
}
