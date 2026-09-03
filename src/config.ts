import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  MCP_AUTH_MODE: z.enum(["api-key", "oauth"]).default("api-key"),
  MCP_API_KEY: z.string().min(32, "must contain at least 32 characters").optional(),
  MCP_PUBLIC_BASE_URL: z.url().optional(),
  MCP_OAUTH_ISSUER_URL: z.url().optional(),
  MCP_OAUTH_JWKS_URL: z.url().optional(),
  MCP_OAUTH_AUDIENCE: z.string().trim().min(1).optional(),
  MCP_OAUTH_REQUIRED_SCOPES: z.string().trim().min(1).optional(),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AZURE_AUTH_MODE: z.enum(["auto", "client-secret", "default"]).default("auto"),
  AZURE_TENANT_ID: z.uuid().optional(),
  AZURE_CLIENT_ID: z.uuid().optional(),
  AZURE_CLIENT_SECRET: z.string().min(1).optional(),
  POWERBI_MCP_READONLY: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(true),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  HTTP_MAX_PAGES: z.coerce.number().int().min(1).max(1_000).default(100),
  HTTP_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).max(52_428_800).default(10_485_760),
  LRO_POLL_BUDGET_MS: z.coerce.number().int().min(0).max(600_000).default(60_000),
  DAX_MAX_ROWS: z.coerce.number().int().min(1).max(10_000).default(1_000),
  DAX_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
  DATA_MAX_ROWS: z.coerce.number().int().min(1).max(1_000).default(100),
  DATA_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
});

export type LogLevel = z.infer<typeof environmentSchema>["LOG_LEVEL"];

export interface ApiKeyAuthConfig {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export interface OAuthAuthConfig {
  readonly mode: "oauth";
  readonly publicBaseUrl: string;
  readonly resourceUrl: string;
  readonly protectedResourceMetadataUrl: string;
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  readonly audience: string;
  readonly requiredScopes: readonly string[];
}

export type McpAuthConfig = ApiKeyAuthConfig | OAuthAuthConfig;

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly auth: McpAuthConfig;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly logLevel: LogLevel;
  readonly azure: {
    readonly mode: "client-secret" | "default";
    readonly tenantId?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
  };
  readonly readOnly: boolean;
  readonly http: {
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly maxPages: number;
    readonly maxResponseBytes: number;
  };
  readonly lroPollBudgetMs: number;
  readonly dax: {
    readonly maxRows: number;
    readonly maxResponseBytes: number;
  };
  readonly data: {
    readonly maxRows: number;
    readonly maxResponseBytes: number;
  };
}

export class ConfigurationError extends Error {
  public readonly code = "INVALID_CONFIGURATION";

  public constructor(public readonly issues: readonly string[]) {
    super(`Invalid server configuration: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
  }
}

const splitCommaSeparated = (value: string | undefined): string[] =>
  value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) ?? [];

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const scopePattern = /^[!#-\[\]-~]+$/;

function normalizeSecureUrl(
  name: string,
  value: string,
  options: { readonly originOnly?: boolean; readonly allowLoopbackHttp?: boolean } = {},
): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

  if (url.protocol !== "https:" && !(options.allowLoopbackHttp && loopback)) {
    throw new ConfigurationError([`${name} must use HTTPS except for local development.`]);
  }
  if (url.username || url.password) {
    throw new ConfigurationError([`${name} must not contain user information.`]);
  }
  if (url.search || url.hash) {
    throw new ConfigurationError([`${name} must not contain a query string or fragment.`]);
  }
  if (options.originOnly && url.pathname !== "/") {
    throw new ConfigurationError([`${name} must contain only an origin without a path.`]);
  }

  return url;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const field = issue.path.join(".") || "environment";
      return `${field}: ${issue.message}`;
    });
    throw new ConfigurationError(issues);
  }

  const configuredPublicUrl = parsed.data.MCP_PUBLIC_BASE_URL
    ? normalizeSecureUrl("MCP_PUBLIC_BASE_URL", parsed.data.MCP_PUBLIC_BASE_URL, {
        originOnly: true,
        allowLoopbackHttp: parsed.data.NODE_ENV !== "production",
      })
    : undefined;
  let auth: McpAuthConfig;
  const publicHostname = configuredPublicUrl?.hostname;

  if (parsed.data.MCP_AUTH_MODE === "api-key") {
    if (!parsed.data.MCP_API_KEY) {
      throw new ConfigurationError(["MCP_API_KEY is required when MCP_AUTH_MODE is api-key."]);
    }
    auth = Object.freeze({ mode: "api-key", apiKey: parsed.data.MCP_API_KEY });
  } else {
    const missing = [
      ["MCP_PUBLIC_BASE_URL", parsed.data.MCP_PUBLIC_BASE_URL],
      ["MCP_OAUTH_ISSUER_URL", parsed.data.MCP_OAUTH_ISSUER_URL],
      ["MCP_OAUTH_JWKS_URL", parsed.data.MCP_OAUTH_JWKS_URL],
      ["MCP_OAUTH_AUDIENCE", parsed.data.MCP_OAUTH_AUDIENCE],
      ["MCP_OAUTH_REQUIRED_SCOPES", parsed.data.MCP_OAUTH_REQUIRED_SCOPES],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new ConfigurationError([
        `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required when MCP_AUTH_MODE is oauth.`,
      ]);
    }

    normalizeSecureUrl("MCP_OAUTH_ISSUER_URL", parsed.data.MCP_OAUTH_ISSUER_URL!, {
      allowLoopbackHttp: parsed.data.NODE_ENV !== "production",
    });
    const jwksUrl = normalizeSecureUrl("MCP_OAUTH_JWKS_URL", parsed.data.MCP_OAUTH_JWKS_URL!, {
      allowLoopbackHttp: parsed.data.NODE_ENV !== "production",
    });
    const requiredScopes = unique(splitCommaSeparated(parsed.data.MCP_OAUTH_REQUIRED_SCOPES));

    if (requiredScopes.length === 0 || requiredScopes.some((scope) => !scopePattern.test(scope))) {
      throw new ConfigurationError([
        "MCP_OAUTH_REQUIRED_SCOPES must contain valid comma-separated OAuth scope tokens.",
      ]);
    }

    const publicBaseUrl = configuredPublicUrl!.origin;
    const resourceUrl = `${publicBaseUrl}/mcp`;
    const protectedResourceMetadataUrl = `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
    auth = Object.freeze({
      mode: "oauth",
      publicBaseUrl,
      resourceUrl,
      protectedResourceMetadataUrl,
      issuerUrl: parsed.data.MCP_OAUTH_ISSUER_URL!,
      jwksUrl: jwksUrl.href,
      audience: parsed.data.MCP_OAUTH_AUDIENCE!,
      requiredScopes: Object.freeze(requiredScopes),
    });
  }

  const localHosts = ["localhost", "127.0.0.1", "[::1]"];
  const explicitHosts = splitCommaSeparated(parsed.data.MCP_ALLOWED_HOSTS);
  const allowedHosts = unique(
    explicitHosts.length > 0
      ? [...explicitHosts, ...(publicHostname ? [publicHostname] : [])]
      : [...localHosts, ...(publicHostname ? [publicHostname] : [])],
  );
  const explicitOrigins = splitCommaSeparated(parsed.data.MCP_ALLOWED_ORIGINS);
  const usesClientSecret =
    parsed.data.AZURE_AUTH_MODE === "client-secret" ||
    (parsed.data.AZURE_AUTH_MODE === "auto" && parsed.data.AZURE_CLIENT_SECRET !== undefined);

  if (usesClientSecret && (!parsed.data.AZURE_TENANT_ID || !parsed.data.AZURE_CLIENT_ID)) {
    throw new ConfigurationError([
      "AZURE_TENANT_ID and AZURE_CLIENT_ID are required when client-secret authentication is selected.",
    ]);
  }

  if (parsed.data.AZURE_AUTH_MODE === "client-secret" && !parsed.data.AZURE_CLIENT_SECRET) {
    throw new ConfigurationError([
      "AZURE_CLIENT_SECRET is required when AZURE_AUTH_MODE is client-secret.",
    ]);
  }

  const azure = Object.freeze({
    mode: usesClientSecret ? ("client-secret" as const) : ("default" as const),
    ...(parsed.data.AZURE_TENANT_ID ? { tenantId: parsed.data.AZURE_TENANT_ID } : {}),
    ...(parsed.data.AZURE_CLIENT_ID ? { clientId: parsed.data.AZURE_CLIENT_ID } : {}),
    ...(parsed.data.AZURE_CLIENT_SECRET ? { clientSecret: parsed.data.AZURE_CLIENT_SECRET } : {}),
  });

  return Object.freeze({
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    auth,
    allowedHosts: Object.freeze(allowedHosts),
    allowedOrigins: Object.freeze(
      explicitOrigins.length > 0 ? unique(explicitOrigins) : [...allowedHosts],
    ),
    logLevel: parsed.data.LOG_LEVEL,
    azure,
    readOnly: parsed.data.POWERBI_MCP_READONLY,
    http: Object.freeze({
      timeoutMs: parsed.data.HTTP_TIMEOUT_MS,
      maxRetries: parsed.data.HTTP_MAX_RETRIES,
      maxPages: parsed.data.HTTP_MAX_PAGES,
      maxResponseBytes: parsed.data.HTTP_MAX_RESPONSE_BYTES,
    }),
    lroPollBudgetMs: parsed.data.LRO_POLL_BUDGET_MS,
    dax: Object.freeze({
      maxRows: parsed.data.DAX_MAX_ROWS,
      maxResponseBytes: parsed.data.DAX_MAX_RESPONSE_BYTES,
    }),
    data: Object.freeze({
      maxRows: parsed.data.DATA_MAX_ROWS,
      maxResponseBytes: parsed.data.DATA_MAX_RESPONSE_BYTES,
    }),
  });
}
