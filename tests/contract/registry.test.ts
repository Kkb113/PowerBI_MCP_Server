import { describe, expect, it } from "vitest";
import {
  RESOURCE_REGISTRY,
  TOOL_NAMES,
  TOOL_REGISTRY,
  WRITE_TOOL_NAMES,
} from "../../src/mcp/registry.js";

const expectedTools = [
  "list_workspaces",
  "list_semantic_models",
  "list_lakehouses",
  "get_lakehouse",
  "list_lakehouse_tables",
  "list_warehouses",
  "get_warehouse",
  "inspect_data_source_schema",
  "sample_data_source_table",
  "get_semantic_model",
  "get_semantic_model_definition",
  "get_model_info",
  "create_semantic_model",
  "update_semantic_model_properties",
  "apply_model_changes",
  "delete_semantic_model",
  "bind_semantic_model_connection",
  "validate_dax",
  "execute_dax",
  "refresh_semantic_model",
  "get_refresh_status",
  "get_operation_status",
  "model_snapshot",
  "model_diff",
  "pre_deploy_gate",
] as const;

describe("MCP registry parity", () => {
  it("matches the first-release tool catalog exactly", () => {
    expect(TOOL_NAMES).toEqual(expectedTools);
    expect(new Set(TOOL_NAMES).size).toBe(expectedTools.length);
  });

  it("keeps schemas, safety annotations, and write classification aligned", () => {
    for (const tool of TOOL_REGISTRY) {
      expect(typeof tool.inputSchema.safeParse).toBe("function");
      expect(tool.annotations.openWorldHint).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(tool.kind === "read");
      expect(tool.annotations.destructiveHint).toBe(tool.kind === "destructive");
    }

    expect(WRITE_TOOL_NAMES).toEqual(
      TOOL_REGISTRY.filter((tool) => tool.kind !== "read").map((tool) => tool.name),
    );
    expect(WRITE_TOOL_NAMES).toEqual([
      "create_semantic_model",
      "update_semantic_model_properties",
      "apply_model_changes",
      "delete_semantic_model",
      "bind_semantic_model_connection",
      "refresh_semantic_model",
    ]);
  });

  it("publishes unique static resource names and URIs", () => {
    const names = RESOURCE_REGISTRY.map((resource) => resource.name);
    const uris = RESOURCE_REGISTRY.map((resource) => resource.uri);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(uris).size).toBe(uris.length);
    expect(uris).toEqual(["fabric://reference/capabilities", "fabric://reference/safety"]);
  });

  it("enforces cross-field requirements in the published schemas", () => {
    const updateProperties = TOOL_REGISTRY.find(
      (tool) => tool.name === "update_semantic_model_properties",
    );
    const preDeploy = TOOL_REGISTRY.find((tool) => tool.name === "pre_deploy_gate");
    const deleteModel = TOOL_REGISTRY.find((tool) => tool.name === "delete_semantic_model");
    const ids = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      semanticModelId: "00000000-0000-4000-8000-000000000002",
    };

    expect(updateProperties?.inputSchema.safeParse(ids).success).toBe(false);
    expect(updateProperties?.inputSchema.safeParse({ ...ids, displayName: "Sales" }).success).toBe(
      true,
    );
    expect(
      updateProperties?.inputSchema.safeParse({
        ...ids,
        description: "x".repeat(257),
      }).success,
    ).toBe(false);
    expect(
      deleteModel?.inputSchema.safeParse({
        ...ids,
        confirmSemanticModelId: ids.semanticModelId,
        confirmDisplayName: "Sales",
      }).success,
    ).toBe(false);
    expect(
      deleteModel?.inputSchema.safeParse({
        ...ids,
        confirmSemanticModelId: ids.semanticModelId,
        confirmDisplayName: "Sales",
        confirmPermanentDelete: true,
      }).success,
    ).toBe(true);
    expect(
      deleteModel?.inputSchema.safeParse({
        ...ids,
        confirmSemanticModelId: "00000000-0000-4000-8000-000000000003",
        confirmDisplayName: "Sales",
        confirmPermanentDelete: true,
      }).success,
    ).toBe(false);
    expect(preDeploy?.inputSchema.safeParse({}).success).toBe(false);
    expect(preDeploy?.inputSchema.safeParse(ids).success).toBe(true);
  });
});
