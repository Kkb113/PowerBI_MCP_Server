import { McpServer } from "@modelcontextprotocol/server";
import { ApiError } from "../clients/errors.js";
import { DomainError } from "../errors.js";
import type { Logger } from "../logging.js";
import { redactResponse } from "../logging.js";
import { ModelError } from "../model/errors.js";
import type { McpToolHandler } from "../services/mcp-workflow-service.js";
import { REFERENCE_COMMIT, SERVER_NAME, SERVER_VERSION } from "../version.js";
import { RESOURCE_REGISTRY, SERVER_INSTRUCTIONS, TOOL_REGISTRY, TOOL_NAMES } from "./registry.js";
import { toolOutputSchema } from "./schemas.js";

export interface FabricMcpServerOptions {
  readonly handler: McpToolHandler;
  readonly logger: Logger;
  readonly knownSecrets?: readonly string[];
  readonly readOnly: boolean;
}

const safetyRules = (readOnly: boolean) => ({
  scope: "Fabric cloud semantic models only",
  canonicalDefinitionFormat: "TMSL",
  phase: 5,
  fabricMutationEnabled: !readOnly,
  controls: [
    "preview before mutation",
    "workspace allowlisting",
    "server-enforced read-only mode",
    "expected definition hash for model changes",
    "repeated ID, exact display-name, and explicit irreversible confirmation before permanent deletion",
    "bounded DAX rows and response bytes",
    "secret-free tool arguments, responses, and logs",
  ],
});

const errorDetails = (error: unknown) => {
  if (error instanceof DomainError) return error.toDetails();
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof ModelError) {
    const issue = error.issues[0];
    return {
      code: error.code,
      message: issue ? `${error.message} ${issue.path}: ${issue.message}` : error.message,
      retryable: false,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "The tool failed because of an unexpected internal error.",
    retryable: false,
  };
};

export function createFabricMcpServer(options: FabricMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "public" },
        "resources/list": { ttlMs: 300_000, cacheScope: "public" },
        "resources/read": { ttlMs: 300_000, cacheScope: "public" },
      },
    },
  );

  for (const tool of TOOL_REGISTRY) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: toolOutputSchema,
        annotations: tool.annotations,
      },
      async (input: unknown) => {
        const startedAt = performance.now();
        try {
          const execution = await options.handler.execute(tool.name, input);
          const output = toolOutputSchema.parse(
            redactResponse(
              {
                ok: true,
                status: execution.status,
                message: execution.message,
                data: execution.data,
                error: null,
              },
              options.knownSecrets,
            ),
          );
          options.logger.info("MCP tool completed", {
            tool: tool.name,
            status: execution.status,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (error: unknown) {
          const details = errorDetails(error);
          const output = toolOutputSchema.parse(
            redactResponse(
              {
                ok: false,
                status: "failed",
                message: details.message,
                data: null,
                error: details,
              },
              options.knownSecrets,
            ),
          );
          options.logger.warn("MCP tool failed", {
            tool: tool.name,
            code: details.code,
            retryable: details.retryable,
            durationMs: Math.round(performance.now() - startedAt),
            ...(details.code === "INTERNAL_ERROR" ? { error } : {}),
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
            structuredContent: output,
            isError: true,
          };
        }
      },
    );
  }

  for (const resource of RESOURCE_REGISTRY) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
        cacheHint: { ttlMs: 300_000, cacheScope: "public" },
      },
      (uri) => {
        const value =
          resource.name === "semantic-model-capabilities"
            ? {
                phase: 5,
                implementationStatus: "mcp_workflows_enabled",
                fabricMutationEnabled: !options.readOnly,
                referenceCommit: REFERENCE_COMMIT,
                tools: TOOL_NAMES,
              }
            : safetyRules(options.readOnly);

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: resource.mimeType,
              text: JSON.stringify(value, null, 2),
            },
          ],
        };
      },
    );
  }

  return server;
}
