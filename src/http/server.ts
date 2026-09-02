import type { Server } from "node:http";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { createHttpApp } from "./app.js";

export async function startHttpServer(config: AppConfig, logger: Logger): Promise<Server> {
  const app = createHttpApp(config, logger);

  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      server.off("error", reject);
      logger.info("HTTP server started", {
        host: config.host,
        port: config.port,
        environment: config.nodeEnv,
      });
      resolve(server);
    });
    server.once("error", reject);
  });
}
