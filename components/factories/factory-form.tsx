"use client";

import { useActionState, useState } from "react";
import type { FactoryFormField, FactoryFormState, FactoryFormValues } from "@/lib/factories/form-state";
import { Button } from "@/components/ui/button";
import { SectionRule } from "@/components/ui/primitives";

type FactoryFormProps = {
  mode: "create" | "edit";
  /** Server action; it redirects on success and returns errors otherwise. */
  action: (state: FactoryFormState, formData: FormData) => Promise<FactoryFormState>;
  initial: FactoryFormValues;
  cancelHref: string;
  /** Docker network name; known only once the factory exists. */
  networkName?: string;
};

/** URL-safe slug suggestion: lowercase letters and digits joined by single hyphens. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

export function FactoryForm({ mode, action, initial, cancelHref, networkName }: FactoryFormProps) {
  const [state, formAction, pending] = useActionState(action, { fieldErrors: {}, values: initial });
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  // Until the user edits the slug, it follows the name.
  const [slugEdited, setSlugEdited] = useState(initial.slug !== "");
  const creating = mode === "create";

  const error = (field: FactoryFormField) => state.fieldErrors[field];
  const describedBy = (field: FactoryFormField) => (error(field) ? `${field}-error` : undefined);
  const fieldError = (field: FactoryFormField) =>
    error(field) ? (
      <p id={`${field}-error`} className="zf-error" role="alert">
        {error(field)}
      </p>
    ) : null;

  return (
    <form action={formAction} className="flex min-h-0 flex-1 flex-col gap-4" noValidate>
      {state.message ? (
        <p className="zf-error" role="alert">
          {state.message}
        </p>
      ) : null}

      <div className="grid max-w-180 grid-cols-2 gap-x-5 gap-y-3">
        <div className="zf-f">
          <label htmlFor="name" className="zf-k">
            Name
          </label>
          <input
            id="name"
            name="name"
            className="zf-input"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (creating && !slugEdited) setSlug(slugify(event.target.value));
            }}
            maxLength={80}
            required
            autoFocus={creating}
            aria-invalid={Boolean(error("name"))}
            aria-describedby={describedBy("name")}
          />
          {fieldError("name")}
        </div>
        <div className="zf-f">
          <label htmlFor="slug" className="zf-k">
            {creating ? "Slug" : "Slug · fixed at creation"}
          </label>
          <input
            id="slug"
            name="slug"
            className="zf-input mono"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              setSlugEdited(true);
            }}
            maxLength={63}
            readOnly={!creating}
            required
            aria-invalid={Boolean(error("slug"))}
            aria-describedby={describedBy("slug")}
          />
          {fieldError("slug")}
        </div>
        <div className="zf-f col-span-2">
          <label htmlFor="description" className="zf-k">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            className="zf-input"
            defaultValue={state.values.description}
            maxLength={500}
            placeholder="optional"
            aria-invalid={Boolean(error("description"))}
            aria-describedby={describedBy("description")}
          />
          {fieldError("description")}
        </div>
      </div>

      <SectionRule>
        <span className="zf-k">Docker network · isolated per factory</span>
      </SectionRule>
      <div className="grid max-w-180 grid-cols-2 gap-x-5 gap-y-3">
        <div className="zf-f">
          <label htmlFor="subnetCidr" className="zf-k">
            Subnet
          </label>
          <input
            id="subnetCidr"
            name="subnetCidr"
            className="zf-input mono"
            defaultValue={state.values.subnetCidr}
            placeholder="172.20.1.0/24"
            required
            aria-invalid={Boolean(error("subnetCidr"))}
            aria-describedby={describedBy("subnetCidr")}
          />
          {fieldError("subnetCidr")}
        </div>
        <div className="zf-f">
          <span className="zf-k">Network</span>
          <div className="zf-in mono">{networkName ?? "zfactory_<id> · assigned on create"}</div>
        </div>
      </div>
      <p className="zf-sub max-w-180">
        A private range (10/8, 172.16/12 or 192.168/16), /16 to /28, that does not overlap another factory. Saving
        changes configuration only: no network or container is created until the factory is started.
      </p>

      <div className="mt-auto flex gap-2 border-t border-line pt-3">
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? "Saving…" : creating ? "Create factory" : "Save changes"}
        </Button>
        <Button variant="ghost" href={cancelHref}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
