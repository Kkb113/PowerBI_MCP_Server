import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Request, Response } from "express";
import { createMcpAuthMiddleware, type OAuthTokenVerifier } from "../auth.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { createFabricMcpServer } from "../mcp/server.js";
import { createMcpWorkflowService } from "../services/factory.js";
import type { McpToolHandler } from "../services/mcp-workflow-service.js";

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: null,
});

async function handleMcpRequest(
  request: Request,
  response: Response,
  logger: Logger,
  config: AppConfig,
  handler: McpToolHandler,
): Promise<void> {
  const server = createFabricMcpServer({
    handler,
    logger,
    knownSecrets: [
      ...(config.auth.mode === "api-key" ? [config.auth.apiKey] : []),
      ...(config.azure.clientSecret ? [config.azure.clientSecret] : []),
    ],
    readOnly: config.readOnly,
  });
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  let closed = false;

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    void server.close().catch((error: unknown) => {
      logger.error("Failed to close request-scoped MCP server", { error });
    });
  };

  response.once("close", close);
  transport.onerror = (error) => {
    logger.error("MCP transport error", { error });
  };

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error: unknown) {
    logger.error("Unhandled MCP request error", { error });
    if (!response.headersSent) {
      response.status(500).json(jsonRpcError(-32_603, "Internal server error"));
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

export interface HttpAppOptions {
  readonly handler?: McpToolHandler;
  readonly oauthTokenVerifier?: OAuthTokenVerifier;
}

export function createHttpApp(config: AppConfig, logger: Logger, options: HttpAppOptions = {}) {
  const handler = options.handler ?? createMcpWorkflowService(config, logger);
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: [...config.allowedHosts],
    allowedOrigins: [...config.allowedOrigins],
    jsonLimit: "1mb",
  });

  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    next();
  });

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/ready", (_request, response) => {
    response.status(200).json({ status: "ready" });
  });

  if (config.auth.mode === "oauth") {
    const protectedResourceMetadata = Object.freeze({
      resource: config.auth.resourceUrl,
      authorization_servers: [config.auth.issuerUrl],
      scopes_supported: [...config.auth.requiredScopes],
      bearer_methods_supported: ["header"],
    });
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.status(200).json(protectedResourceMetadata);
    });
    app.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => {
      response.status(200).json(protectedResourceMetadata);
    });
  }

  app.use("/mcp", createMcpAuthMiddleware(config.auth, logger, options.oauthTokenVerifier));
  app.post("/mcp", (request, response) => {
    void handleMcpRequest(request, response, logger, config, handler);
  });
  app.all("/mcp", (_request, response) => {
    response.set("Allow", "POST");
    response.status(405).json(jsonRpcError(-32_600, "Method not allowed"));
  });

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  return app;
}
