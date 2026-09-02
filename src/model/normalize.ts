import { createHash } from "node:crypto";
import { parseAndValidateModelSpec } from "./validation.js";
import type { ModelSpec } from "./schemas.js";

const canonicalName = (name: string): string => name.toLocaleLowerCase("en-US");

const byName = <T extends { readonly name: string }>(left: T, right: T): number =>
  canonicalName(left.name).localeCompare(canonicalName(right.name), "en-US") ||
  left.name.localeCompare(right.name, "en-US");

const normalizeString = (value: string): string =>
  value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

const normalizeStrings = (value: unknown): unknown => {
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) return value.map(normalizeStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeStrings(entry)]),
    );
  }
  return value;
};

export function normalizeModelSpec(input: unknown): ModelSpec {
  const parsed = parseAndValidateModelSpec(normalizeStrings(input));
  return {
    ...parsed,
    annotations: [...parsed.annotations].sort(byName),
    dataSources: [...parsed.dataSources]
      .sort(byName)
      .map((source) => ({ ...source, annotations: [...source.annotations].sort(byName) })),
    expressions: [...parsed.expressions].sort(byName).map((expression) => ({
      ...expression,
      annotations: [...expression.annotations].sort(byName),
    })),
    tables: [...parsed.tables].sort(byName).map((table) => ({
      ...table,
      annotations: [...table.annotations].sort(byName),
      columns: [...table.columns]
        .sort(byName)
        .map((column) => ({ ...column, annotations: [...column.annotations].sort(byName) })),
      partitions: [...table.partitions].sort(byName).map((partition) => ({
        ...partition,
        annotations: [...partition.annotations].sort(byName),
      })),
      measures: [...table.measures]
        .sort(byName)
        .map((measure) => ({ ...measure, annotations: [...measure.annotations].sort(byName) })),
      hierarchies: [...table.hierarchies].sort(byName).map((hierarchy) => ({
        ...hierarchy,
        levels: [...hierarchy.levels],
        annotations: [...hierarchy.annotations].sort(byName),
      })),
    })),
    relationships: [...parsed.relationships].sort(byName).map((relationship) => ({
      ...relationship,
      annotations: [...relationship.annotations].sort(byName),
    })),
    calculationGroups: [...parsed.calculationGroups]
      .sort((left, right) => byName({ name: left.tableName }, { name: right.tableName }))
      .map((group) => ({
        ...group,
        annotations: [...group.annotations].sort(byName),
        columnAnnotations: [...group.columnAnnotations].sort(byName),
        items: group.items.map((item) => ({
          ...item,
          annotations: [...item.annotations].sort(byName),
        })),
      })),
    roles: [...parsed.roles].sort(byName).map((role) => ({
      ...role,
      annotations: [...role.annotations].sort(byName),
      tablePermissions: [...role.tablePermissions].sort((left, right) =>
        byName({ name: left.table }, { name: right.table }),
      ),
    })),
  };
}

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

export function stableModelJson(input: unknown, space = 0): string {
  return JSON.stringify(canonicalizeJson(normalizeModelSpec(input)), undefined, space);
}

export function hashModelSpec(input: unknown): string {
  return createHash("sha256").update(stableModelJson(input)).digest("hex");
}
