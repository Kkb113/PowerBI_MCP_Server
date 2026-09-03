export type ExternalService = "azure-identity" | "fabric" | "fabric-sql" | "powerbi";

export interface ApiErrorOptions {
  readonly service: ExternalService;
  readonly operation: string;
  readonly retryable?: boolean;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly serviceCode?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class ApiError extends Error {
  public readonly service: ExternalService;
  public readonly operation: string;
  public readonly retryable: boolean;
  public readonly httpStatus: number | undefined;
  public readonly requestId: string | undefined;
  public readonly serviceCode: string | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(
    public readonly code: string,
    message: string,
    options: ApiErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.service = options.service;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
    this.requestId = options.requestId;
    this.serviceCode = options.serviceCode;
    this.retryAfterMs = options.retryAfterMs;
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      service: this.service,
      operation: this.operation,
      retryable: this.retryable,
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.serviceCode === undefined ? {} : { serviceCode: this.serviceCode }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    };
  }
}

export function assertWritable(
  readOnly: boolean,
  operation: string,
  service: ExternalService = "fabric",
): void {
  if (readOnly) {
    throw new ApiError("READ_ONLY_VIOLATION", "The server is configured in read-only mode.", {
      service,
      operation,
    });
  }
}
