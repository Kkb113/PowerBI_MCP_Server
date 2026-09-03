import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { McpAuthConfig, OAuthAuthConfig } from "./config.js";
import type { Logger } from "./logging.js";

const unauthorizedBody = {
  error: {
    code: "UNAUTHORIZED",
    message: "A valid bearer token is required.",
  },
} as const;

const forbiddenBody = {
  error: {
    code: "INSUFFICIENT_SCOPE",
    message: "The bearer token does not grant every required scope.",
  },
} as const;

const acceptedJwtAlgorithms = ["RS256", "PS256", "ES256"] as const;
const maximumBearerTokenLength = 16_384;

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  const token = match?.[1];
  return token && token.length <= maximumBearerTokenLength ? token : undefined;
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

export type OAuthTokenVerifier = (token: string) => Promise<JWTPayload>;

function createOAuthTokenVerifier(config: OAuthAuthConfig): OAuthTokenVerifier {
  const keySet = createRemoteJWKSet(new URL(config.jwksUrl), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });

  return async (token) => {
    const result = await jwtVerify(token, keySet, {
      algorithms: [...acceptedJwtAlgorithms],
      issuer: config.issuerUrl,
      audience: config.audience,
      requiredClaims: ["exp"],
    });
    return result.payload;
  };
}

function readTokenScopes(payload: JWTPayload): ReadonlySet<string> {
  const claim = payload["scope"] ?? payload["scp"];
  if (typeof claim !== "string") {
    return new Set();
  }
  return new Set(claim.split(/\s+/).filter((scope) => scope.length > 0));
}

const quoteChallengeValue = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

function createOAuthChallenge(
  config: OAuthAuthConfig,
  error?: "invalid_token" | "insufficient_scope",
): string {
  const parameters = [
    `resource_metadata=${quoteChallengeValue(config.protectedResourceMetadataUrl)}`,
    `scope=${quoteChallengeValue(config.requiredScopes.join(" "))}`,
  ];
  if (error) {
    parameters.push(`error=${quoteChallengeValue(error)}`);
  }
  return `Bearer ${parameters.join(", ")}`;
}

export function createOAuthBearerAuthMiddleware(
  config: OAuthAuthConfig,
  logger: Logger,
  verifier: OAuthTokenVerifier = createOAuthTokenVerifier(config),
): RequestHandler {
  return (request, response, next): void => {
    const token = extractBearerToken(request.header("authorization"));
    if (!token) {
      logger.warn("Rejected unauthenticated MCP request", {
        method: request.method,
        path: request.path,
      });
      response.set("WWW-Authenticate", createOAuthChallenge(config));
      response.status(401).json(unauthorizedBody);
      return;
    }

    void verifier(token)
      .then((payload) => {
        const grantedScopes = readTokenScopes(payload);
        const missingScopes = config.requiredScopes.filter((scope) => !grantedScopes.has(scope));
        if (missingScopes.length > 0) {
          logger.warn("Rejected MCP request with insufficient OAuth scope", {
            method: request.method,
            path: request.path,
            missingScopeCount: missingScopes.length,
          });
          response.set("WWW-Authenticate", createOAuthChallenge(config, "insufficient_scope"));
          response.status(403).json(forbiddenBody);
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        logger.warn("Rejected MCP request with an invalid OAuth token", {
          method: request.method,
          path: request.path,
          reason: error instanceof Error ? error.name : "TokenVerificationError",
        });
        response.set("WWW-Authenticate", createOAuthChallenge(config, "invalid_token"));
        response.status(401).json(unauthorizedBody);
      });
  };
}

export function createMcpAuthMiddleware(
  config: McpAuthConfig,
  logger: Logger,
  oauthTokenVerifier?: OAuthTokenVerifier,
): RequestHandler {
  if (config.mode === "api-key") {
    return createBearerAuthMiddleware(config.apiKey, logger);
  }
  return createOAuthBearerAuthMiddleware(config, logger, oauthTokenVerifier);
}
