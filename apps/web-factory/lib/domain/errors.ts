/** Typed domain failures. Messages are safe to show to users; they never carry database internals. */
export const DOMAIN_ERROR_CODES = ["VALIDATION", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT"] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    /** Machine-readable context, e.g. the field or rule that failed. */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function isDomainError(error: unknown, code?: DomainErrorCode): error is DomainError {
  return error instanceof DomainError && (code === undefined || error.code === code);
}
