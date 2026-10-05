import { DomainError } from "@/lib/domain/errors";

/** What a PLC configuration action returns when it does not redirect: input echoed back with errors. */
export type ActionState = {
  message?: string;
  fieldErrors: Record<string, string>;
  values: Record<string, string>;
};

export const EMPTY_ACTION_STATE: ActionState = { fieldErrors: {}, values: {} };

const GENERIC_MESSAGE = "Something went wrong. Nothing was saved; try again.";

/** Database constraints whose violation belongs to one form field. */
const CONSTRAINT_FIELD: Record<string, string> = {
  DeviceInstance_factoryId_name_key: "name",
  DeviceInstance_name_check: "name",
  FactoryModule_factoryRackId_slotIndex_key: "slotIndex",
};

const CONSTRAINT_MESSAGE: Record<string, string> = {
  DeviceInstance_factoryId_name_key: "A device with this name already exists in this factory.",
};

export function readForm(formData: FormData, fields: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = formData.get(field);
      return [field, typeof value === "string" ? value : ""];
    }),
  );
}

/** Maps a failure onto the form: per-field errors where the cause is known, a form message otherwise. */
export function toActionState(error: unknown, values: Record<string, string>): ActionState {
  if (!(error instanceof DomainError)) return { message: GENERIC_MESSAGE, fieldErrors: {}, values };

  const fieldErrors: Record<string, string> = {};
  const issues = error.details.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues as Array<{ path?: unknown; message?: unknown }>) {
      if (typeof issue.path === "string" && issue.path in values && typeof issue.message === "string") {
        fieldErrors[issue.path] ??= issue.message;
      }
    }
  }
  const constraint = typeof error.details.constraint === "string" ? error.details.constraint : undefined;
  const field =
    typeof error.details.field === "string" ? error.details.field : constraint && CONSTRAINT_FIELD[constraint];
  if (field && field in values) fieldErrors[field] ??= (constraint && CONSTRAINT_MESSAGE[constraint]) || error.message;

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  return { message: hasFieldErrors ? undefined : error.message, fieldErrors, values };
}
