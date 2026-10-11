import { DomainError } from "@/lib/domain/errors";
import { explainDomainError, type ValidationExplanation } from "@/lib/domain/validation-explanations";

/** A compiler finding, with its position in the program source. */
export type ProgramDiagnostic = {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
};

/**
 * What a program, runtime or simulator action returns. These actions stay on the page:
 * `notice` says what happened, `message` why it did not, `diagnostics` where a program
 * does not compile.
 */
export type OperationState = {
  notice?: string;
  message?: string;
  diagnostics?: ProgramDiagnostic[];
  /** The program version a save or deploy stored the editor's text as. */
  savedVersion?: number;
  /** Why it was refused, for people and agents (TASK-1007). */
  explanation?: ValidationExplanation;
};

export const EMPTY_OPERATION_STATE: OperationState = {};

const GENERIC_MESSAGE = "Something went wrong. Try again.";

function isDiagnostic(value: unknown): value is ProgramDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.message === "string" &&
    typeof candidate.line === "number" &&
    typeof candidate.column === "number" &&
    (candidate.severity === "error" || candidate.severity === "warning")
  );
}

/**
 * Maps a failure onto the page. Domain messages are written for the user and carry no
 * host detail; anything else is replaced by a generic message.
 */
export function toOperationState(error: unknown): OperationState {
  if (!(error instanceof DomainError)) return { message: GENERIC_MESSAGE };
  const diagnostics = Array.isArray(error.details.diagnostics) ? error.details.diagnostics.filter(isDiagnostic) : [];
  const explanation = explainDomainError(error);
  return diagnostics.length > 0
    ? { message: error.message, diagnostics, explanation }
    : { message: error.message, explanation };
}
