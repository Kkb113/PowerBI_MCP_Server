import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  definitionHashSchema,
  fabricIdSchema,
  jsonValueSchema,
  modelChangeSchema,
  modelSpecSchema,
} from "./schemas.js";

export type ToolKind = "read" | "write" | "destructive";

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodObject;
  readonly annotations: ToolAnnotations;
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const satisfies ToolAnnotations;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const satisfies ToolAnnotations;

const idempotentWriteAnnotations = {
  ...writeAnnotations,
  idempotentHint: true,
} as const satisfies ToolAnnotations;

const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const satisfies ToolAnnotations;

const workspaceInput = z.object({
  workspaceId: fabricIdSchema,
});

const modelInput = workspaceInput.extend({
  semanticModelId: fabricIdSchema,
});

const paginationInput = z.object({
  continuationToken: z.string().min(1).max(8_192).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const proposedDefinitionSchema = z.union([
  z.object({ kind: z.literal("model_spec"), model: modelSpecSchema }),
  z.object({
    kind: z.literal("operations"),
    expectedDefinitionHash: definitionHashSchema,
    operations: z.array(modelChangeSchema).min(1).max(500),
  }),
]);

export const TOOL_REGISTRY = [
  {
    name: "list_workspaces",
    title: "List Fabric workspaces",
    description: "List Fabric workspaces visible to the configured server identity.",
    kind: "read",
    inputSchema: paginationInput,
    annotations: readAnnotations,
  },
  {
    name: "list_semantic_models",
    title: "List semantic models",
    description: "List semantic models in one permitted Fabric workspace.",
    kind: "read",
    inputSchema: workspaceInput.merge(paginationInput),
    annotations: readAnnotations,
  },
  {
    name: "get_semantic_model",
    title: "Get semantic model",
    description: "Read semantic model item properties without returning its definition.",
    kind: "read",
    inputSchema: modelInput,
    annotations: readAnnotations,
  },
  {
    name: "get_semantic_model_definition",
    title: "Get semantic model definition",
    description: "Read a normalized model summary and optionally its complete TMSL definition.",
    kind: "read",
    inputSchema: modelInput.extend({
      includeDefinition: z.boolean().default(false),
      format: z.literal("TMSL").default("TMSL"),
    }),
    annotations: readAnnotations,
  },
  {
    name: "get_model_info",
    title: "Get model information",
    description: "Return bounded semantic model object metadata and counts.",
    kind: "read",
    inputSchema: modelInput.extend({
      sections: z
        .array(
          z.enum([
            "tables",
            "columns",
            "measures",
            "relationships",
            "partitions",
            "hierarchies",
            "calculation_groups",
            "expressions",
            "roles",
          ]),
        )
        .min(1)
        .default(["tables", "measures", "relationships"]),
      limitPerSection: z.number().int().min(1).max(1_000).default(200),
    }),
    annotations: readAnnotations,
  },
  {
    name: "create_semantic_model",
    title: "Create semantic model",
    description: "Preview or create a semantic model from the canonical typed model specification.",
    kind: "write",
    inputSchema: workspaceInput.extend({
      displayName: z.string().trim().min(1).max(256),
      description: z.string().max(4_000).optional(),
      model: modelSpecSchema,
      apply: z.boolean().default(false),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "update_semantic_model_properties",
    title: "Update semantic model properties",
    description: "Rename a semantic model item or change its description.",
    kind: "write",
    inputSchema: modelInput
      .extend({
        displayName: z.string().trim().min(1).max(256).optional(),
        description: z.string().max(4_000).nullable().optional(),
        apply: z.boolean().default(false),
      })
      .refine((value) => value.displayName !== undefined || value.description !== undefined, {
        message: "At least one of displayName or description is required.",
      }),
    annotations: idempotentWriteAnnotations,
  },
  {
    name: "apply_model_changes",
    title: "Apply model changes",
    description:
      "Preview or apply an atomic batch of typed model object changes after a definition-hash check.",
    kind: "destructive",
    inputSchema: modelInput.extend({
      expectedDefinitionHash: definitionHashSchema,
      operations: z.array(modelChangeSchema).min(1).max(500),
      apply: z.boolean().default(false),
    }),
    annotations: destructiveAnnotations,
  },
  {
    name: "delete_semantic_model",
    title: "Delete semantic model",
    description: "Soft-delete a semantic model after exact display-name confirmation.",
    kind: "destructive",
    inputSchema: modelInput.extend({
      confirmDisplayName: z.string().trim().min(1).max(256),
      apply: z.boolean().default(false),
    }),
    annotations: destructiveAnnotations,
  },
  {
    name: "bind_semantic_model_connection",
    title: "Bind semantic model connection",
    description: "Bind one semantic model data-source reference to one existing Fabric connection.",
    kind: "write",
    inputSchema: modelInput.extend({
      sourceName: z.string().trim().min(1).max(256),
      connectionId: fabricIdSchema,
      apply: z.boolean().default(false),
    }),
    annotations: idempotentWriteAnnotations,
  },
  {
    name: "validate_dax",
    title: "Validate DAX",
    description: "Run a bounded, read-only validation probe for a DAX expression.",
    kind: "read",
    inputSchema: modelInput.extend({
      expression: z.string().trim().min(1).max(100_000),
      culture: z.string().trim().min(2).max(32).optional(),
    }),
    annotations: readAnnotations,
  },
  {
    name: "execute_dax",
    title: "Execute DAX query",
    description: "Execute a read-only DAX query and return bounded structured rows.",
    kind: "read",
    inputSchema: modelInput.extend({
      query: z.string().trim().min(1).max(100_000),
      maxRows: z.number().int().min(1).max(10_000).default(1_000),
      includeNulls: z.boolean().default(false),
      culture: z.string().trim().min(2).max(32).optional(),
    }),
    annotations: readAnnotations,
  },
  {
    name: "refresh_semantic_model",
    title: "Refresh semantic model",
    description: "Start a semantic model refresh and return its service-owned operation state.",
    kind: "write",
    inputSchema: modelInput.extend({
      refreshType: z.enum(["automatic", "full", "clearValues", "calculate"]).default("automatic"),
      apply: z.boolean().default(false),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "get_refresh_status",
    title: "Get refresh status",
    description: "Read status and bounded diagnostics for a semantic model refresh.",
    kind: "read",
    inputSchema: modelInput.extend({
      refreshId: z.string().trim().min(1).max(512),
    }),
    annotations: readAnnotations,
  },
  {
    name: "get_operation_status",
    title: "Get Fabric operation status",
    description: "Read a Fabric long-running operation state and result location.",
    kind: "read",
    inputSchema: z.object({
      operationId: z.string().trim().min(1).max(512),
    }),
    annotations: readAnnotations,
  },
  {
    name: "model_snapshot",
    title: "Create model snapshot",
    description: "Return normalized model metadata and its deterministic definition hash.",
    kind: "read",
    inputSchema: modelInput.extend({
      includeDefinition: z.boolean().default(false),
    }),
    annotations: readAnnotations,
  },
  {
    name: "model_diff",
    title: "Compare model definition",
    description:
      "Compare the live definition with a proposed model specification or operation batch.",
    kind: "read",
    inputSchema: modelInput.extend({
      proposed: proposedDefinitionSchema,
    }),
    annotations: readAnnotations,
  },
  {
    name: "pre_deploy_gate",
    title: "Run pre-deployment checks",
    description: "Run structural, naming, DAX-lint, and connection checks without changing Fabric.",
    kind: "read",
    inputSchema: z
      .object({
        workspaceId: fabricIdSchema.optional(),
        semanticModelId: fabricIdSchema.optional(),
        model: modelSpecSchema.optional(),
        checks: z
          .array(z.enum(["structure", "names", "dax", "relationships", "connections"]))
          .min(1)
          .default(["structure", "names", "dax", "relationships", "connections"]),
        options: z.record(z.string(), jsonValueSchema).default({}),
      })
      .refine(
        (value) =>
          value.model !== undefined ||
          (value.workspaceId !== undefined && value.semanticModelId !== undefined),
        {
          message: "Provide a model specification or both workspaceId and semanticModelId.",
        },
      ),
    annotations: readAnnotations,
  },
] as const satisfies readonly ToolDefinition[];

export const TOOL_NAMES = TOOL_REGISTRY.map((tool) => tool.name);
export const WRITE_TOOL_NAMES = TOOL_REGISTRY.filter((tool) => tool.kind !== "read").map(
  (tool) => tool.name,
);

export interface ResourceDefinition {
  readonly name: string;
  readonly uri: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: "application/json";
}

export const RESOURCE_REGISTRY = [
  {
    name: "semantic-model-capabilities",
    uri: "fabric://reference/capabilities",
    title: "Semantic model MCP capabilities",
    description: "Frozen Phase 1 tool catalog and implementation status.",
    mimeType: "application/json",
  },
  {
    name: "semantic-model-safety",
    uri: "fabric://reference/safety",
    title: "Semantic model safety rules",
    description: "Server-enforced lifecycle and destructive-operation safety expectations.",
    mimeType: "application/json",
  },
] as const satisfies readonly ResourceDefinition[];

export const SERVER_INSTRUCTIONS = [
  "This server targets Microsoft Fabric cloud semantic models using a canonical TMSL model definition.",
  "Phase 1 exposes a frozen contract only; every Fabric-facing tool returns NOT_IMPLEMENTED and performs no Fabric request or mutation.",
  "Treat tool annotations as hints only. Future write implementations will also enforce preview-by-default, workspace allowlisting, expected-definition hashes, and explicit confirmation for deletion.",
  "Never place credentials, access tokens, tenant secrets, or connection secrets in tool arguments.",
].join(" ");
