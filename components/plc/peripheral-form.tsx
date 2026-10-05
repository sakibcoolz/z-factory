"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { signalTypeLabel } from "@/lib/catalog/format";
import type { PeripheralOptionsView } from "@/lib/domain/plc-config-view";
import type { ActionState } from "@/lib/plc/form-state";

type PeripheralFormProps = {
  /** Server action; it redirects back to the connections view on success. */
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  options: PeripheralOptionsView;
  cancelHref: string;
};

/**
 * Creates a device from a catalog model and wires it to the PLC. Each terminal offers only
 * the free channels of the right class and signal type.
 */
export function PeripheralForm({ action, options, cancelHref }: PeripheralFormProps) {
  const [state, formAction, pending] = useActionState(action, {
    fieldErrors: {},
    values: { name: options.suggestedName, role: "" },
  });
  const blocked = options.connection === null || options.terminals.some((terminal) => terminal.options.length === 0);
  const nameError = state.fieldErrors.name;

  return (
    <form action={formAction} className="zf-cell gap-3" data-selected="true" noValidate>
      <div className="flex items-baseline justify-between">
        <span className="text-fg-strong">{`Add ${options.model.modelName}`}</span>
        <span className="zf-k">{options.model.categoryName}</span>
      </div>
      {state.message ? (
        <p className="zf-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-x-5 gap-y-3">
        <div className="zf-f">
          <label htmlFor="name" className="zf-k">
            Name
          </label>
          <input
            id="name"
            name="name"
            className="zf-input mono"
            defaultValue={state.values.name}
            maxLength={63}
            required
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? "name-error" : undefined}
          />
          {nameError ? (
            <p id="name-error" className="zf-error" role="alert">
              {nameError}
            </p>
          ) : null}
        </div>
        <div className="zf-f">
          <label htmlFor="role" className="zf-k">
            Role
          </label>
          <input
            id="role"
            name="role"
            className="zf-input"
            defaultValue={state.values.role}
            maxLength={120}
            placeholder="optional"
          />
        </div>
      </div>

      {options.connection === "PROTOCOL" ? (
        <p className="zf-sub">{`Connects over ${options.protocols.join(", ").replace("MODBUS_TCP", "Modbus TCP")}; it uses no I/O channel.`}</p>
      ) : null}
      {options.connection === null ? (
        <p className="zf-error" role="alert">
          This device has no terminal and no protocol in common with this PLC.
        </p>
      ) : null}

      {options.terminals.length > 0 ? (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Terminal</th>
              <th>Needs</th>
              <th>Channel</th>
            </tr>
          </thead>
          <tbody>
            {options.terminals.map((terminal) => {
              const field = `terminal:${terminal.id}`;
              return (
                <tr key={terminal.id}>
                  <td className="mono">
                    <label htmlFor={field}>{terminal.terminalLabel ?? "—"}</label>
                  </td>
                  <td className="mono">{`${terminal.required} · ${signalTypeLabel(terminal.signalType)}`}</td>
                  <td>
                    {terminal.options.length > 0 ? (
                      <select
                        id={field}
                        name={field}
                        className="zf-input mono"
                        defaultValue={state.values[field] ?? terminal.suggestedPointId ?? ""}
                      >
                        {terminal.options.map((option) => (
                          <option key={option.pointId} value={option.pointId}>
                            {`${option.label} · ${option.logicalAddress}`}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className="zf-error"
                        role="alert"
                      >{`no free ${terminal.required} channel for this signal`}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={pending || blocked}>
          {pending ? "Adding…" : "Add and wire"}
        </Button>
        <Button variant="ghost" href={cancelHref}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
