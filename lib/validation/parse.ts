import type { z } from "zod";
import { DomainError } from "@/lib/domain/errors";

/** Parses untrusted input, converting schema failures into a VALIDATION domain error. */
export function parseInput<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  const first = issues[0];
  const summary = first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : "Invalid input.";
  throw new DomainError("VALIDATION", summary, { issues });
}
