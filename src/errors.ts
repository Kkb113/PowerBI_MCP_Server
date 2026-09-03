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
