export interface ErrorDetails {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export class DomainError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "DomainError";
  }

  public toDetails(): ErrorDetails {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function notImplemented(toolName: string): DomainError {
  return new DomainError(
    "NOT_IMPLEMENTED",
    `The ${toolName} tool is part of the frozen Phase 1 contract but has no Fabric implementation yet.`,
  );
}
