import { createMicrosoftApiClients } from "../src/clients/factory.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { createLogger } from "../src/logging.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.readOnly) {
    throw new ConfigurationError([
      "POWERBI_MCP_READONLY must be true for the live Phase 2 smoke check.",
    ]);
  }
  if (config.allowedWorkspaceIds.length === 0) {
    throw new ConfigurationError([
      "FABRIC_ALLOWED_WORKSPACE_IDS must contain at least one development workspace for the live smoke check.",
    ]);
  }

  const logger = createLogger({
    level: config.logLevel,
    knownSecrets: [
      config.apiKey,
      ...(config.azure.clientSecret ? [config.azure.clientSecret] : []),
    ],
  });
  const clients = createMicrosoftApiClients(config, logger);
  const workspaces = await clients.fabric.listWorkspaces();
  const semanticModelCounts: Record<string, number> = {};

  for (const workspace of workspaces) {
    const semanticModels = await clients.fabric.listSemanticModels(workspace.id);
    semanticModelCounts[workspace.id] = semanticModels.length;
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      readOnly: config.readOnly,
      configuredWorkspaceCount: config.allowedWorkspaceIds.length,
      visibleWorkspaceCount: workspaces.length,
      semanticModelCounts,
    })}\n`,
  );
}

try {
  await main();
} catch (error: unknown) {
  const logger = createLogger({
    level: "error",
    knownSecrets: [process.env["MCP_API_KEY"] ?? "", process.env["AZURE_CLIENT_SECRET"] ?? ""],
  });
  logger.error("Live smoke check failed", { error });
  process.exitCode = 1;
}
