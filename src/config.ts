import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  MCP_API_KEY: z.string().min(32, "must contain at least 32 characters"),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  RENDER_EXTERNAL_HOSTNAME: z.string().trim().min(1).optional(),
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

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly apiKey: string;
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

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const field = issue.path.join(".") || "environment";
      return `${field}: ${issue.message}`;
    });
    throw new ConfigurationError(issues);
  }

  const localHosts = ["localhost", "127.0.0.1", "[::1]"];
  const explicitHosts = splitCommaSeparated(parsed.data.MCP_ALLOWED_HOSTS);
  const renderHosts = parsed.data.RENDER_EXTERNAL_HOSTNAME
    ? [parsed.data.RENDER_EXTERNAL_HOSTNAME]
    : [];
  const allowedHosts = unique(
    explicitHosts.length > 0 ? [...explicitHosts, ...renderHosts] : [...localHosts, ...renderHosts],
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
    apiKey: parsed.data.MCP_API_KEY,
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
