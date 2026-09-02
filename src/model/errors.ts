export interface ModelIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ModelReference {
  readonly objectType: string;
  readonly path: string;
  readonly property: string;
}

export interface ModelErrorOptions {
  readonly issues?: readonly ModelIssue[];
  readonly references?: readonly ModelReference[];
  readonly cause?: unknown;
}

export class ModelError extends Error {
  public readonly issues: readonly ModelIssue[];
  public readonly references: readonly ModelReference[];

  public constructor(
    public readonly code: string,
    message: string,
    options: ModelErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelError";
    this.issues = Object.freeze([...(options.issues ?? [])]);
    this.references = Object.freeze([...(options.references ?? [])]);
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.issues.length === 0 ? {} : { issues: this.issues }),
      ...(this.references.length === 0 ? {} : { references: this.references }),
    };
  }
}
