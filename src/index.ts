import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http/server.js";
import { createLogger } from "./logging.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    knownSecrets: [
      config.apiKey,
      ...(config.azure.clientSecret ? [config.azure.clientSecret] : []),
    ],
  });
  const server = await startHttpServer(config, logger);
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("Stopping HTTP server", { signal });

    server.close((error) => {
      if (error) {
        logger.error("HTTP server shutdown failed", { error });
        process.exitCode = 1;
      } else {
        logger.info("HTTP server stopped");
      }
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error: unknown) => {
    const logger = createLogger({ level: "error" });
    logger.error("Server startup failed", { error });
    process.exitCode = 1;
  });
}
