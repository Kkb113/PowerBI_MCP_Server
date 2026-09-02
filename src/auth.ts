import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "./logging.js";

const unauthorizedBody = {
  error: {
    code: "UNAUTHORIZED",
    message: "A valid bearer token is required.",
  },
} as const;

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1];
}

export function createBearerAuthMiddleware(expectedToken: string, logger: Logger): RequestHandler {
  const expectedDigest = digest(expectedToken);

  return (request, response, next): void => {
    const presentedToken = extractBearerToken(request.header("authorization"));
    const valid = presentedToken ? timingSafeEqual(digest(presentedToken), expectedDigest) : false;

    if (!valid) {
      logger.warn("Rejected unauthorized MCP request", {
        method: request.method,
        path: request.path,
      });
      response.set("WWW-Authenticate", 'Bearer realm="fabric-semantic-model-mcp"');
      response.status(401).json(unauthorizedBody);
      return;
    }

    next();
  };
}
