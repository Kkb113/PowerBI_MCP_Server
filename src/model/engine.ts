import { findModelReferences, type ModelTarget } from "./dependencies.js";
import { diffModelSpecs, type SemanticDiff } from "./diff.js";
import { ModelError } from "./errors.js";
import { hashModelSpec, normalizeModelSpec } from "./normalize.js";
import {
  calculationGroupSchema,
  calculationItemSchema,
  columnSchema,
  dataSourceSchema,
  hierarchySchema,
  measureSchema,
  modelChangeSchema,
  namedExpressionSchema,
  partitionSchema,
  relationshipSchema,
  roleSchema,
  tableSchema,
  type ModelChange,
  type ModelObjectType,
  type ModelSpec,
} from "./schemas.js";
import { parseAndValidateModelSpec } from "./validation.js";

export interface AppliedModelOperation {
  readonly index: number;
  readonly action: ModelChange["action"];
  readonly objectType: ModelObjectType;
  readonly path: string;
}

export interface ModelTransactionResult {
  readonly model: ModelSpec;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly diff: SemanticDiff;
  readonly operations: readonly AppliedModelOperation[];
}

const canonicalName = (name: string): string => name.toLocaleLowerCase("en-US");
const sameName = (left: string, right: string): boolean =>
  canonicalName(left) === canonicalName(right);

const pathFor = (target: ModelTarget): string =>
  target.parentName === undefined ? target.name : `${target.parentName}/${target.name}`;

const failMissing = (target: ModelTarget): never => {
  throw new ModelError(
    "MODEL_OBJECT_NOT_FOUND",
    `${target.objectType} '${pathFor(target)}' does not exist.`,
  );
};

const failDuplicate = (target: ModelTarget, name = target.name): never => {
  throw new ModelError(
    "MODEL_OBJECT_ALREADY_EXISTS",
    `${target.objectType} '${target.parentName ? `${target.parentName}/` : ""}${name}' already exists.`,
  );
};

const requireNoReferences = (model: ModelSpec, target: ModelTarget): void => {
  const references = findModelReferences(model, target);
  if (references.length > 0) {
    throw new ModelError(
      "MODEL_DEPENDENCY_CONFLICT",
      `${target.objectType} '${pathFor(target)}' is still referenced by ${references.length} model object(s).`,
      { references },
    );
  }
};

const findIndex = <T extends { readonly name: string }>(
  values: readonly T[],
  name: string,
): number => values.findIndex((value) => sameName(value.name, name));

const parseChange = (input: unknown, index: number): ModelChange => {
  const parsed = modelChangeSchema.safeParse(input);
  if (!parsed.success) {
    throw new ModelError(
      "MODEL_CHANGE_INVALID",
      `Change at index ${index} does not match the CRUD contract.`,
      {
        issues: parsed.error.issues.map((entry) => ({
          code: "INVALID_CHANGE",
          path: `changes[${index}]${entry.path.length > 0 ? `.${entry.path.map(String).join(".")}` : ""}`,
          message: entry.message,
        })),
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
};

interface NamedSchema<T extends { name: string }> {
  parse(input: unknown): T;
}

const mutateNamedCollection = <T extends { name: string }>(
  model: ModelSpec,
  values: T[],
  change: ModelChange,
  schema: NamedSchema<T>,
): void => {
  const target = change.target;
  const position = findIndex(values, target.name);
  switch (change.action) {
    case "create": {
      if (position >= 0) failDuplicate(target);
      const value = schema.parse(change.value);
      if (!sameName(value.name, target.name)) {
        throw new ModelError(
          "MODEL_CHANGE_TARGET_MISMATCH",
          `Change target '${target.name}' does not match value name '${value.name}'.`,
        );
      }
      values.push(value);
      return;
    }
    case "update": {
      if (position < 0) failMissing(target);
      const value = schema.parse(change.value);
      if (!sameName(value.name, target.name)) {
        throw new ModelError(
          "MODEL_CHANGE_TARGET_MISMATCH",
          `Change target '${target.name}' does not match value name '${value.name}'.`,
        );
      }
      values[position] = value;
      return;
    }
    case "delete":
      if (position < 0) failMissing(target);
      requireNoReferences(model, target);
      values.splice(position, 1);
      return;
    case "rename":
      if (position < 0) failMissing(target);
      if (findIndex(values, change.newName) >= 0) failDuplicate(target, change.newName);
      requireNoReferences(model, target);
      {
        const current = values[position];
        if (current === undefined) {
          throw new ModelError(
            "MODEL_OBJECT_NOT_FOUND",
            `${target.objectType} '${pathFor(target)}' does not exist.`,
          );
        }
        current.name = change.newName;
      }
  }
};

const parentTable = (model: ModelSpec, target: ModelTarget): ModelSpec["tables"][number] => {
  if (!target.parentName) {
    throw new ModelError(
      "MODEL_CHANGE_INVALID",
      `${target.objectType} changes require a parentName.`,
    );
  }
  const table = model.tables.find((candidate) => sameName(candidate.name, target.parentName ?? ""));
  if (!table) {
    throw new ModelError(
      "MODEL_PARENT_NOT_FOUND",
      `Parent table '${target.parentName}' does not exist.`,
    );
  }
  return table;
};

const mutateCalculationGroups = (model: ModelSpec, change: ModelChange): void => {
  const target = change.target;
  const position = model.calculationGroups.findIndex((group) =>
    sameName(group.tableName, target.name),
  );
  switch (change.action) {
    case "create": {
      if (position >= 0) failDuplicate(target);
      const value = calculationGroupSchema.parse(change.value);
      if (!sameName(value.tableName, target.name)) {
        throw new ModelError(
          "MODEL_CHANGE_TARGET_MISMATCH",
          `Change target '${target.name}' does not match value tableName '${value.tableName}'.`,
        );
      }
      model.calculationGroups.push(value);
      return;
    }
    case "update": {
      if (position < 0) failMissing(target);
      const value = calculationGroupSchema.parse(change.value);
      if (!sameName(value.tableName, target.name)) {
        throw new ModelError(
          "MODEL_CHANGE_TARGET_MISMATCH",
          `Change target '${target.name}' does not match value tableName '${value.tableName}'.`,
        );
      }
      model.calculationGroups[position] = value;
      return;
    }
    case "delete":
      if (position < 0) failMissing(target);
      requireNoReferences(model, target);
      model.calculationGroups.splice(position, 1);
      return;
    case "rename":
      if (position < 0) failMissing(target);
      if (
        model.calculationGroups.some((group) => sameName(group.tableName, change.newName)) ||
        model.tables.some((table) => sameName(table.name, change.newName))
      ) {
        failDuplicate(target, change.newName);
      }
      requireNoReferences(model, target);
      {
        const current = model.calculationGroups[position];
        if (current === undefined) {
          throw new ModelError(
            "MODEL_OBJECT_NOT_FOUND",
            `${target.objectType} '${pathFor(target)}' does not exist.`,
          );
        }
        current.tableName = change.newName;
      }
  }
};

const mutateCalculationItems = (model: ModelSpec, change: ModelChange): void => {
  const target = change.target;
  if (!("parentName" in target) || !target.parentName) {
    throw new ModelError("MODEL_CHANGE_INVALID", "calculation_item changes require a parentName.");
  }
  const parentName = target.parentName;
  const group = model.calculationGroups.find((candidate) =>
    sameName(candidate.tableName, parentName),
  );
  if (!group) {
    throw new ModelError(
      "MODEL_PARENT_NOT_FOUND",
      `Parent calculation group '${parentName}' does not exist.`,
    );
  }
  mutateNamedCollection(model, group.items, change, calculationItemSchema);
};

const applyChange = (model: ModelSpec, change: ModelChange): void => {
  switch (change.target.objectType) {
    case "expression":
      mutateNamedCollection(model, model.expressions, change, namedExpressionSchema);
      return;
    case "data_source":
      mutateNamedCollection(model, model.dataSources, change, dataSourceSchema);
      return;
    case "table":
      mutateNamedCollection(model, model.tables, change, tableSchema);
      return;
    case "relationship":
      mutateNamedCollection(model, model.relationships, change, relationshipSchema);
      return;
    case "role":
      mutateNamedCollection(model, model.roles, change, roleSchema);
      return;
    case "column":
      mutateNamedCollection(model, parentTable(model, change.target).columns, change, columnSchema);
      return;
    case "partition":
      mutateNamedCollection(
        model,
        parentTable(model, change.target).partitions,
        change,
        partitionSchema,
      );
      return;
    case "measure":
      mutateNamedCollection(
        model,
        parentTable(model, change.target).measures,
        change,
        measureSchema,
      );
      return;
    case "hierarchy":
      mutateNamedCollection(
        model,
        parentTable(model, change.target).hierarchies,
        change,
        hierarchySchema,
      );
      return;
    case "calculation_group":
      mutateCalculationGroups(model, change);
      return;
    case "calculation_item":
      mutateCalculationItems(model, change);
  }
};

export function applyModelChanges(
  modelInput: unknown,
  changesInput: readonly unknown[],
): ModelTransactionResult {
  const before = normalizeModelSpec(modelInput);
  const workingCopy = structuredClone(before);
  const operations: AppliedModelOperation[] = [];

  for (const [index, input] of changesInput.entries()) {
    const change = parseChange(input, index);
    applyChange(workingCopy, change);
    operations.push({
      index,
      action: change.action,
      objectType: change.target.objectType,
      path: pathFor(change.target),
    });
  }

  const model = normalizeModelSpec(parseAndValidateModelSpec(workingCopy));
  return {
    model,
    beforeHash: hashModelSpec(before),
    afterHash: hashModelSpec(model),
    diff: diffModelSpecs(before, model),
    operations,
  };
}
