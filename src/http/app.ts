import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Request, Response } from "express";
import { createBearerAuthMiddleware } from "../auth.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { createFabricMcpServer } from "../mcp/server.js";

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: null,
});

async function handleMcpRequest(
  request: Request,
  response: Response,
  logger: Logger,
): Promise<void> {
  const server = createFabricMcpServer();
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

export function createHttpApp(config: AppConfig, logger: Logger) {
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

  app.use("/mcp", createBearerAuthMiddleware(config.apiKey, logger));
  app.post("/mcp", (request, response) => {
    void handleMcpRequest(request, response, logger);
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
