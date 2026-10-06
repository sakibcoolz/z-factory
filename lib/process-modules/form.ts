/**
 * Reading a module form (TASK-604). Settings arrive as `config.<key>` fields with their
 * declared kind in `configType.<key>`, so a number stays a number before the service
 * checks it against the type. Pure functions; shared by the server actions.
 */

export function formField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Settings of the selected type; an empty field is left out and takes the type's default. */
export function configFields(formData: FormData): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("config.") || typeof value !== "string") continue;
    const name = key.slice("config.".length);
    const kind = formField(formData, `configType.${name}`);
    if (kind === "boolean") {
      config[name] = value === "true";
      continue;
    }
    if (value === "") continue;
    config[name] = kind === "number" || kind === "integer" ? Number(value) : value;
  }
  return config;
}
