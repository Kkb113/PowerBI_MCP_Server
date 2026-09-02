import { McpServer } from "@modelcontextprotocol/server";
import { notImplemented } from "../errors.js";
import { REFERENCE_COMMIT, SERVER_NAME, SERVER_VERSION } from "../version.js";
import { RESOURCE_REGISTRY, SERVER_INSTRUCTIONS, TOOL_REGISTRY, TOOL_NAMES } from "./registry.js";
import { toolOutputSchema } from "./schemas.js";

const safetyRules = {
  scope: "Fabric cloud semantic models only",
  canonicalDefinitionFormat: "TMSL",
  phase: 4,
  fabricMutationEnabled: false,
  controls: [
    "preview before mutation",
    "workspace allowlisting",
    "expected definition hash for model changes",
    "repeated ID, exact display-name, and explicit irreversible confirmation before permanent deletion",
    "secret-free tool arguments and responses",
  ],
} as const;

export function createFabricMcpServer(): McpServer {
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
      () => {
        const error = notImplemented(tool.name);
        const output = {
          ok: false,
          status: "not_implemented" as const,
          message: error.message,
          data: null,
          error: error.toDetails(),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
          structuredContent: output,
          isError: true,
        };
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
                phase: 4,
                implementationStatus: "lifecycle_service_internal",
                fabricMutationEnabled: false,
                referenceCommit: REFERENCE_COMMIT,
                tools: TOOL_NAMES,
              }
            : safetyRules;

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
