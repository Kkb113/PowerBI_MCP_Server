import type { LogLevel } from "./config.js";

const REDACTED = "[REDACTED]";
const sensitiveKeyPattern = /authorization|cookie|password|secret|token|api[-_]?key/i;
const responseSensitiveKeyPattern =
  /authorization|cookie|password|client[-_]?secret|access[-_]?token|api[-_]?key/i;
const bearerPattern = /\bBearer\s+[^\s,;]+/gi;
const assignmentPattern = /\b(access_token|client_secret|password|api_key|apikey)=([^\s&,;]+)/gi;

type LogSink = (line: string) => void;
type LogFields = Readonly<Record<string, unknown>>;

const levelPriority: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function redactString(value: string, knownSecrets: readonly string[]): string {
  let redacted = value
    .replaceAll(bearerPattern, `Bearer ${REDACTED}`)
    .replaceAll(assignmentPattern, (_match, key: string) => `${key}=${REDACTED}`);

  for (const secret of knownSecrets) {
    if (secret.length >= 6) {
      redacted = redacted.replaceAll(secret, REDACTED);
    }
  }

  return redacted;
}

export function redact(value: unknown, knownSecrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    return redactString(value, knownSecrets);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, knownSecrets),
      stack: value.stack ? redactString(value.stack, knownSecrets) : undefined,
      cause: value.cause ? redact(value.cause, knownSecrets) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, knownSecrets));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKeyPattern.test(key) ? REDACTED : redact(item, knownSecrets),
      ]),
    );
  }

  return value;
}

export function redactResponse(value: unknown, knownSecrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    return redactString(value, knownSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactResponse(item, knownSecrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        responseSensitiveKeyPattern.test(key) ? REDACTED : redactResponse(item, knownSecrets),
      ]),
    );
  }
  return value;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly knownSecrets?: readonly string[];
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? console.error;
  const now = options.now ?? (() => new Date());
  const knownSecrets = options.knownSecrets ?? [];

  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (levelPriority[level] < levelPriority[options.level]) {
      return;
    }

    const entry = redact(
      {
        timestamp: now().toISOString(),
        level,
        message,
        ...fields,
      },
      knownSecrets,
    );
    sink(JSON.stringify(entry));
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
