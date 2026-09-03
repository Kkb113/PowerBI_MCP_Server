import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";
import type { McpToolHandler } from "../../src/services/mcp-workflow-service.js";

export const TEST_API_KEY = "phase-one-test-api-key-000000000000";

export const TEST_CONFIG: AppConfig = Object.freeze({
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  apiKey: TEST_API_KEY,
  allowedHosts: Object.freeze(["127.0.0.1", "localhost"]),
  allowedOrigins: Object.freeze(["127.0.0.1", "localhost"]),
  logLevel: "error",
  azure: Object.freeze({ mode: "default" }),
  readOnly: true,
  http: Object.freeze({
    timeoutMs: 1_000,
    maxRetries: 0,
    maxPages: 10,
    maxResponseBytes: 1_048_576,
  }),
  lroPollBudgetMs: 1_000,
  dax: Object.freeze({ maxRows: 100, maxResponseBytes: 65_536 }),
  data: Object.freeze({ maxRows: 25, maxResponseBytes: 65_536 }),
});

export interface TestHttpServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

const listen = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, TEST_CONFIG.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

const defaultHandler: McpToolHandler = {
  execute: (name) =>
    Promise.resolve({
      status: "success",
      message: `${name} test handler completed.`,
      data: { tool: name },
    }),
};

export async function startTestHttpServer(
  handler: McpToolHandler = defaultHandler,
): Promise<TestHttpServer> {
  const logger = createLogger({ level: "error", knownSecrets: [TEST_API_KEY], sink: () => {} });
  const server = createServer(createHttpApp(TEST_CONFIG, logger, { handler }));
  await listen(server);
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://${TEST_CONFIG.host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
