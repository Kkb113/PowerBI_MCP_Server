import { createMicrosoftApiClients } from "../src/clients/factory.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { createLogger } from "../src/logging.js";

try {
  process.loadEnvFile();
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.readOnly) {
    throw new ConfigurationError([
      "POWERBI_MCP_READONLY must be true for the live read-only API smoke check.",
    ]);
  }
  const logger = createLogger({
    level: "error",
    knownSecrets: [
      config.apiKey,
      ...(config.azure.clientSecret ? [config.azure.clientSecret] : []),
    ],
  });
  const clients = createMicrosoftApiClients(config, logger);
  const workspaces = await clients.fabric.listWorkspaces();
  let semanticModelCount = 0;

  for (const workspace of workspaces) {
    const semanticModels = await clients.fabric.listSemanticModels(workspace.id);
    semanticModelCount += semanticModels.length;
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      readOnly: config.readOnly,
      visibleWorkspaceCount: workspaces.length,
      semanticModelCount,
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
