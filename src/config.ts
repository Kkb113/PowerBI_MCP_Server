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
  });
}
