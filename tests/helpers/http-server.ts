import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthTokenVerifier } from "../../src/auth.js";
import type { AppConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";
import type { McpToolHandler } from "../../src/services/mcp-workflow-service.js";

export const TEST_API_KEY = "local-test-api-key-000000000000000";

export const TEST_CONFIG: AppConfig = Object.freeze({
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  auth: Object.freeze({ mode: "api-key", apiKey: TEST_API_KEY }),
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

export interface TestHttpServerOptions {
  readonly config?: AppConfig;
  readonly oauthTokenVerifier?: OAuthTokenVerifier;
}

const listen = (server: Server, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
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
  options: TestHttpServerOptions = {},
): Promise<TestHttpServer> {
  const config = options.config ?? TEST_CONFIG;
  const knownSecrets = config.auth.mode === "api-key" ? [config.auth.apiKey] : [];
  const logger = createLogger({ level: "error", knownSecrets, sink: () => {} });
  const server = createServer(
    createHttpApp(config, logger, {
      handler,
      ...(options.oauthTokenVerifier ? { oauthTokenVerifier: options.oauthTokenVerifier } : {}),
    }),
  );
  await listen(server, config.host);
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://${config.host}:${address.port}`,
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
