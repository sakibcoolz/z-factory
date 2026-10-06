"use client";

import { type ReactNode, useActionState, useState } from "react";
import type { AssignableDevice, TestInputView } from "@/lib/domain/module-designer-view";
import type { ModuleIoCandidate, ModuleIoRow } from "@/lib/domain/module-io-view";
import { INTERLOCK_OPERATORS, type ModuleSignal } from "@/lib/domain/process-module";
import type { ModuleDetail, ModuleTypeDetail } from "@/lib/domain/process-module-view";
import { EMPTY_OPERATION_STATE, type OperationState } from "@/lib/plc/operation-state";
import { ConfigFieldInput } from "./module-form";

type Action = (state: OperationState, formData: FormData) => Promise<OperationState>;

function Result({ state, pending }: { state: OperationState; pending: boolean }) {
  if (pending) return null;
  return (
    <div role="status" aria-live="polite">
      {state.message ? <p className="zf-error whitespace-normal">{state.message}</p> : null}
      {state.notice ? <p className="zf-notice whitespace-normal">{state.notice}</p> : null}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="zf-f">
      <label htmlFor={htmlFor} className="zf-k">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Name, location, profile and the type's settings; saving goes through the module service. */
export function ModuleSettingsForm({
  module,
  type,
  action,
}: {
  module: ModuleDetail;
  type: ModuleTypeDetail;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-2" aria-label="Module settings">
      <div className="grid grid-cols-4 gap-2.5">
        <Field label="Name" htmlFor="module-name">
          <input
            id="module-name"
            name="name"
            className="zf-input mono"
            defaultValue={module.name}
            required
            disabled={pending}
          />
        </Field>
        <Field label="Location" htmlFor="module-location">
          <input
            id="module-location"
            name="location"
            className="zf-input"
            defaultValue={module.location ?? ""}
            disabled={pending}
          />
        </Field>
        {type.profiles.length > 0 ? (
          <Field label="Profile" htmlFor="module-profile">
            <select
              id="module-profile"
              name="profile"
              className="zf-input mono"
              defaultValue={module.profile ?? ""}
              disabled={pending}
            >
              {type.profiles.map((profile) => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {type.configFields.map((field) => (
          <ConfigFieldInput
            key={field.key}
            field={field}
            value={module.config[field.key]}
            idPrefix="module"
            disabled={pending}
          />
        ))}
      </div>
      <Result state={state} pending={pending} />
      <div>
        <button type="submit" className="zf-btn" data-variant="primary" data-size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

/** Puts one of the devices that fit a role into it. */
export function RoleAssignForm({
  roleKey,
  roleName,
  devices,
  full,
  action,
}: {
  roleKey: string;
  roleName: string;
  devices: AssignableDevice[];
  full: boolean;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const id = `assign-${roleKey}`;
  return (
    <form action={formAction} className="flex flex-col gap-1" aria-label={`Assign a device as ${roleName}`}>
      <input type="hidden" name="operation" value="assign" />
      <input type="hidden" name="roleKey" value={roleKey} />
      <div className="flex flex-wrap items-end gap-1.5">
        <select
          id={id}
          name="deviceId"
          className="zf-input mono"
          aria-label={`Device for ${roleName}`}
          disabled={pending || full || devices.length === 0}
        >
          {devices.length === 0 ? <option value="">no device of a fitting category</option> : null}
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {`${device.name} · ${device.categoryName} · ${device.modelName}`}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="zf-btn"
          data-size="sm"
          disabled={pending || full || devices.length === 0}
          title={full ? "The role has every device it takes." : undefined}
        >
          {pending ? "Assigning…" : "Assign"}
        </button>
      </div>
      <Result state={state} pending={pending} />
    </form>
  );
}

const candidateLabel = (candidate: ModuleIoCandidate) =>
  `${candidate.plcName} · ${candidate.tagName} · ${candidate.logicalAddress ?? "no address"} · ${candidate.dataType}${candidate.unit ? ` ${candidate.unit}` : ""}`;

/**
 * The picker of one signal: free compatible tags first, then every other tag disabled with
 * the reason it cannot be used, as the wiring editor does. Binds, rebinds or releases.
 */
export function SignalBindForm({
  row,
  candidates,
  action,
}: {
  row: ModuleIoRow;
  candidates: ModuleIoCandidate[];
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const free = candidates.filter((candidate) => candidate.refusal === null && candidate.tagId !== row.binding?.tagId);
  const refused = candidates.filter((candidate) => candidate.refusal !== null);
  const [tagId, setTagId] = useState(free[0]?.tagId ?? "");
  const chosen = candidates.find((candidate) => candidate.tagId === tagId);
  const bound = row.binding !== null;
  const id = `bind-${row.signal.key}`;
  return (
    <form action={formAction} className="flex flex-col gap-1" aria-label={`Bind ${row.signal.name}`}>
      <input type="hidden" name="signalKey" value={row.signal.key} />
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          id={id}
          name="tagId"
          className="zf-input mono"
          aria-label={`Tag for ${row.signal.name}`}
          value={tagId}
          onChange={(event) => setTagId(event.target.value)}
          disabled={pending || candidates.length === 0}
        >
          {free.length === 0 ? <option value="">no free compatible tag</option> : null}
          {free.map((candidate) => (
            <option key={candidate.tagId} value={candidate.tagId}>
              {candidateLabel(candidate)}
            </option>
          ))}
          {refused.length > 0 ? (
            <optgroup label="not possible">
              {refused.map((candidate) => (
                <option key={candidate.tagId} value={candidate.tagId} disabled>
                  {`${candidateLabel(candidate)} — ${candidate.refusal?.message ?? ""}`}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <button
          type="submit"
          name="operation"
          value={bound ? "rebind" : "bind"}
          className="zf-btn"
          data-variant="primary"
          data-size="sm"
          disabled={pending || !chosen || chosen.refusal !== null}
        >
          {pending ? "Saving…" : bound ? "Move" : "Bind"}
        </button>
        {bound ? (
          <button
            type="submit"
            name="operation"
            value="release"
            className="zf-btn"
            data-variant="danger"
            data-size="sm"
            disabled={pending}
          >
            Release
          </button>
        ) : null}
      </div>
      <Result state={state} pending={pending} />
    </form>
  );
}

const SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;

/** Adds an interlock over the signals of the module's profile; the service checks it. */
export function InterlockForm({ signals, action }: { signals: ModuleSignal[]; action: Action }) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const outputs = signals.filter((signal) => signal.direction === "OUTPUT");
  const conditions = signals.filter((signal) => signal.direction !== "INTERNAL");
  const [whenKey, setWhenKey] = useState(conditions[0]?.key ?? "");
  const when = conditions.find((signal) => signal.key === whenKey);
  const operators = when?.dataType === "BOOL" ? INTERLOCK_OPERATORS.slice(0, 2) : INTERLOCK_OPERATORS.slice(2);
  return (
    <form action={formAction} className="flex flex-col gap-2" aria-label="New interlock">
      <input type="hidden" name="operation" value="add" />
      <div className="grid grid-cols-4 gap-2.5">
        <Field label="Code" htmlFor="interlock-code">
          <input
            id="interlock-code"
            name="code"
            className="zf-input mono"
            placeholder="HIGH_PRESSURE_STOP"
            required
            disabled={pending}
          />
        </Field>
        <Field label="Name" htmlFor="interlock-name">
          <input id="interlock-name" name="name" className="zf-input" required disabled={pending} />
        </Field>
        <Field label="Severity" htmlFor="interlock-severity">
          <select
            id="interlock-severity"
            name="severity"
            className="zf-input"
            defaultValue="WARNING"
            disabled={pending}
          >
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severity.toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Blocks output" htmlFor="interlock-blocks">
          <select
            id="interlock-blocks"
            name="blocks"
            className="zf-input mono"
            disabled={pending || outputs.length === 0}
          >
            {outputs.map((signal) => (
              <option key={signal.key} value={signal.key}>
                {signal.key}
              </option>
            ))}
          </select>
        </Field>
        <Field label="While signal" htmlFor="interlock-when">
          <select
            id="interlock-when"
            name="whenSignal"
            className="zf-input mono"
            value={whenKey}
            onChange={(event) => setWhenKey(event.target.value)}
            disabled={pending}
          >
            {conditions.map((signal) => (
              <option key={signal.key} value={signal.key}>
                {signal.key}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Operator" htmlFor="interlock-operator">
          <select id="interlock-operator" name="operator" className="zf-input mono" disabled={pending}>
            {operators.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </select>
        </Field>
        {when && when.dataType !== "BOOL" ? (
          <Field label={`Value${when.unit ? ` (${when.unit})` : ""}`} htmlFor="interlock-value">
            <input
              id="interlock-value"
              name="value"
              type="number"
              step="any"
              className="zf-input mono"
              required
              disabled={pending}
            />
          </Field>
        ) : null}
      </div>
      <Result state={state} pending={pending} />
      <div>
        <button type="submit" className="zf-btn" data-size="sm" disabled={pending || outputs.length === 0}>
          {pending ? "Adding…" : "Add interlock"}
        </button>
      </div>
    </form>
  );
}

/** Restores the module's bindings from an exported `module-io.json`. */
export function ImportIoForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-1" aria-label="Import bindings">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="file"
          name="document"
          accept="application/json,.json"
          className="zf-input"
          aria-label="Bindings file"
          required
          disabled={pending}
        />
        <button type="submit" className="zf-btn" data-size="sm" disabled={pending}>
          {pending ? "Importing…" : "Import bindings"}
        </button>
      </div>
      <p className="zf-sub">
        Replaces every binding of this module with the file&apos;s, all or nothing; PLCs and tags are found by name.
      </p>
      <Result state={state} pending={pending} />
    </form>
  );
}

const formatValue = (value: number, input: TestInputView) =>
  input.bool ? (value !== 0 ? "on" : "off") : `${value}${input.unit ? ` ${input.unit}` : ""}`;

const modeLabel = (input: TestInputView) => {
  if (input.mode === "AUTO") return "AUTO";
  if (input.mode === "MANUAL_OVERRIDE") return "MANUAL_OVERRIDE";
  const profile = input.profile;
  return profile?.kind === "RAMP"
    ? `SCENARIO ramp ${profile.from} → ${profile.to} in ${profile.durationS} s`
    : "SCENARIO";
};

/**
 * One value the PLC reads, with its test controls (Phase 08, TASK-802): what is delivered and
 * where it comes from, a manual value or a ramp, and Clear back to AUTO. The server checks the
 * range; its refusal is shown under the row.
 */
export function TestInputRow({ input, action }: { input: TestInputView; action: Action }) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const [mode, setMode] = useState<"MANUAL_OVERRIDE" | "SCENARIO">("MANUAL_OVERRIDE");
  const id = (name: string) => `override-${input.signal}-${name}`;
  const overridden = input.mode !== "AUTO";
  return (
    <tr data-mode={input.mode}>
      <td>
        <span className="mono">{input.signal}</span>
        <span className="zf-sub block">{`${input.name}${input.tag ? ` → ${input.tag}` : ""}`}</span>
      </td>
      <td className="mono">
        <b className="text-fg-strong">{formatValue(input.effective, input)}</b>
        {overridden ? <span className="zf-sub block">{`model: ${formatValue(input.calculated, input)}`}</span> : null}
      </td>
      <td>
        <span className="mono" data-overridden={overridden}>
          {modeLabel(input)}
        </span>
        <span className="zf-sub block">
          {overridden
            ? `since ${input.sinceTimeS.toFixed(1)} s${input.source ? ` · by ${input.source}` : ""}`
            : "from the model"}
        </span>
      </td>
      <td>
        <form action={formAction} className="flex flex-col gap-1" aria-label={`Override ${input.signal}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            {input.bool ? (
              <>
                <input type="hidden" name="mode" value="MANUAL_OVERRIDE" />
                <select
                  id={id("value")}
                  name="value"
                  className="zf-input"
                  aria-label={`Value for ${input.signal}`}
                  defaultValue="1"
                  disabled={pending}
                >
                  <option value="1">on</option>
                  <option value="0">off</option>
                </select>
              </>
            ) : (
              <>
                <select
                  id={id("mode")}
                  name="mode"
                  className="zf-input"
                  aria-label={`Mode for ${input.signal}`}
                  value={mode}
                  onChange={(event) => setMode(event.target.value as "MANUAL_OVERRIDE" | "SCENARIO")}
                  disabled={pending}
                >
                  <option value="MANUAL_OVERRIDE">manual value</option>
                  <option value="SCENARIO">ramp</option>
                </select>
                {mode === "MANUAL_OVERRIDE" ? (
                  <input
                    id={id("value")}
                    name="value"
                    type="number"
                    step="any"
                    className="zf-input mono w-24"
                    aria-label={`Value for ${input.signal}`}
                    placeholder={`${input.min}–${input.max}`}
                    disabled={pending}
                  />
                ) : (
                  <>
                    <input
                      name="from"
                      type="number"
                      step="any"
                      className="zf-input mono w-20"
                      aria-label={`Ramp from for ${input.signal}`}
                      placeholder="from"
                      defaultValue={input.effective}
                      disabled={pending}
                    />
                    <input
                      name="to"
                      type="number"
                      step="any"
                      className="zf-input mono w-20"
                      aria-label={`Ramp to for ${input.signal}`}
                      placeholder="to"
                      disabled={pending}
                    />
                    <input
                      name="durationS"
                      type="number"
                      step="any"
                      min={0.1}
                      className="zf-input mono w-20"
                      aria-label={`Ramp seconds for ${input.signal}`}
                      placeholder="s"
                      disabled={pending}
                    />
                  </>
                )}
                <span className="zf-sub">{input.unit}</span>
              </>
            )}
            <button
              type="submit"
              name="operation"
              value="set"
              className="zf-btn"
              data-variant="primary"
              data-size="sm"
              disabled={pending}
            >
              {pending ? "Setting…" : "Override"}
            </button>
            <button
              type="submit"
              name="operation"
              value="clear"
              className="zf-btn"
              data-size="sm"
              disabled={pending || !overridden}
              title={overridden ? undefined : "Already AUTO"}
            >
              Clear
            </button>
          </div>
          <Result state={state} pending={pending} />
        </form>
      </td>
    </tr>
  );
}
