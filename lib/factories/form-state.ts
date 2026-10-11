import { DomainError } from "@/lib/domain/errors";
import { explainDomainError, type ValidationExplanation } from "@/lib/domain/validation-explanations";

export const FACTORY_FORM_FIELDS = ["name", "slug", "description", "subnetCidr"] as const;
export type FactoryFormField = (typeof FACTORY_FORM_FIELDS)[number];
export type FactoryFormValues = Record<FactoryFormField, string>;

/** What a factory form action returns when it does not redirect: the input echoed back with errors. */
export type FactoryFormState = {
  message?: string;
  fieldErrors: Partial<Record<FactoryFormField, string>>;
  values: FactoryFormValues;
  /** Why it was refused, for people and agents (TASK-1007). */
  explanation?: ValidationExplanation;
};

export type DeleteFactoryState = {
  message?: string;
  /** Why it was refused, for people and agents (TASK-1007). */
  explanation?: ValidationExplanation;
};

export function readFactoryForm(formData: FormData): FactoryFormValues {
  const text = (field: FactoryFormField) => {
    const value = formData.get(field);
    return typeof value === "string" ? value : "";
  };
  return { name: text("name"), slug: text("slug"), description: text("description"), subnetCidr: text("subnetCidr") };
}

const CONSTRAINT_FIELD: Record<string, FactoryFormField> = {
  Factory_slug_key: "slug",
  Factory_slug_check: "slug",
  Factory_ownerId_name_key: "name",
  Factory_name_check: "name",
  Factory_subnetCidr_key: "subnetCidr",
  Factory_subnet_no_overlap: "subnetCidr",
};

const isField = (value: unknown): value is FactoryFormField =>
  typeof value === "string" && (FACTORY_FORM_FIELDS as readonly string[]).includes(value);

const GENERIC_MESSAGE = "Something went wrong. Nothing was saved; try again.";

/** Message for an unexpected failure. Internal details never reach the browser. */
export function toErrorMessage(error: unknown): string {
  return error instanceof DomainError ? error.message : GENERIC_MESSAGE;
}

/** Maps a failure onto the form: per-field errors where the cause is known, a form message otherwise. */
export function toFormState(error: unknown, values: FactoryFormValues): FactoryFormState {
  if (!(error instanceof DomainError)) return { message: GENERIC_MESSAGE, fieldErrors: {}, values };

  const fieldErrors: FactoryFormState["fieldErrors"] = {};
  const issues = error.details.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues as Array<{ path?: unknown; message?: unknown }>) {
      if (isField(issue.path) && typeof issue.message === "string") fieldErrors[issue.path] ??= issue.message;
    }
  }
  const constraint = error.details.constraint;
  const field = isField(error.details.field)
    ? error.details.field
    : typeof constraint === "string"
      ? CONSTRAINT_FIELD[constraint]
      : undefined;
  if (field) fieldErrors[field] ??= error.message;

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  return {
    message: hasFieldErrors ? undefined : error.message,
    fieldErrors,
    values,
    explanation: explainDomainError(error),
  };
}
