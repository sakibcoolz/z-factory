"use client";

import { type ReactNode, useActionState, useState } from "react";
import type { PlcLinkOperation } from "@/lib/domain/plc-communication";
import type { CommunicationLinkView, LinkTagOption, PlcCommunicationView } from "@/lib/domain/plc-communication-view";
import { EMPTY_OPERATION_STATE, type OperationState } from "@/lib/plc/operation-state";

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

const tagLabel = (option: LinkTagOption) =>
  `${option.name} · ${option.logicalAddress ?? "—"} · ${option.dataType}${option.scale !== 1 ? ` ×${option.scale}` : ""}${option.unit ? ` ${option.unit}` : ""}`;

function TagSelect({
  id,
  name,
  label,
  options,
}: {
  id: string;
  name: string;
  label: string;
  options: LinkTagOption[];
}) {
  const usable = options.filter((option) => option.refusal === null);
  const refused = options.filter((option) => option.refusal !== null);
  return (
    <Field label={label} htmlFor={id}>
      <select id={id} name={name} className="zf-input mono" aria-label={label} defaultValue={usable[0]?.tagId ?? ""}>
        {usable.length === 0 ? <option value="">no possible tag</option> : null}
        {usable.map((option) => (
          <option key={option.tagId} value={option.tagId}>
            {tagLabel(option)}
          </option>
        ))}
        {refused.length > 0 ? (
          <optgroup label="not possible">
            {refused.map((option) => (
              <option key={option.tagId} value={option.tagId} disabled>
                {`${tagLabel(option)} — ${option.refusal}`}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </Field>
  );
}

/** Adds a value to a link: READ fills a tag of the client, WRITE sends one to a command of the server. */
export function MappingForm({ entry, action }: { entry: CommunicationLinkView; action: Action }) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const [operation, setOperation] = useState<PlcLinkOperation>("READ");
  const options = entry.options?.[operation];
  if (!options) return null;
  const id = (name: string) => `${name}-${entry.link.id}`;
  return (
    <form
      action={formAction}
      className="flex flex-col gap-1.5"
      aria-label={`New value on the link to ${entry.peer.name}`}
    >
      <div className="grid grid-cols-4 gap-2.5">
        <Field label="Direction" htmlFor={id("operation")}>
          <select
            id={id("operation")}
            name="operation"
            className="zf-input"
            value={operation}
            onChange={(event) => setOperation(event.target.value as PlcLinkOperation)}
            disabled={pending}
          >
            <option value="READ">{`READ — ${entry.peer.name} value into this PLC`}</option>
            <option value="WRITE">{`WRITE — this PLC's value to a ${entry.peer.name} command`}</option>
          </select>
        </Field>
        <TagSelect
          key={`local-${operation}`}
          id={id("local")}
          name="localTagId"
          label={operation === "READ" ? "Into this PLC's tag" : "This PLC's value"}
          options={options.local}
        />
        <TagSelect
          key={`remote-${operation}`}
          id={id("remote")}
          name="remoteTagId"
          label={operation === "READ" ? `From ${entry.peer.name}'s tag` : `To ${entry.peer.name}'s command or setpoint`}
          options={options.remote}
        />
        <Field label="Interval (ms, empty = link's)" htmlFor={id("interval")}>
          <input
            id={id("interval")}
            name="updateIntervalMs"
            type="number"
            min={50}
            max={60000}
            className="zf-input mono"
            disabled={pending}
          />
        </Field>
      </div>
      <Result state={state} pending={pending} />
      <div>
        <button type="submit" className="zf-btn" data-variant="primary" data-size="sm" disabled={pending}>
          {pending ? "Adding…" : "Add value"}
        </button>
      </div>
    </form>
  );
}

export function LinkSettings({ entry, action }: { entry: CommunicationLinkView; action: Action }) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const id = (name: string) => `${name}-settings-${entry.link.id}`;
  return (
    <form
      action={formAction}
      className="flex flex-col gap-1.5"
      aria-label={`Settings of the link to ${entry.peer.name}`}
    >
      <input type="hidden" name="operation" value="update" />
      <div className="grid grid-cols-4 gap-2.5">
        <Field label="Relationship" htmlFor={id("relationship")}>
          <select
            id={id("relationship")}
            name="relationship"
            className="zf-input"
            defaultValue={entry.link.relationship}
            disabled={pending}
          >
            <option value="COMMUNICATES_WITH">communicates with</option>
            <option value="SUPERVISES">supervises</option>
          </select>
        </Field>
        <Field label="Poll interval (ms)" htmlFor={id("poll")}>
          <input
            id={id("poll")}
            name="pollIntervalMs"
            type="number"
            min={50}
            max={60000}
            className="zf-input mono"
            defaultValue={entry.link.pollIntervalMs}
            disabled={pending}
          />
        </Field>
        <Field label="Unit id" htmlFor={id("unit")}>
          <input
            id={id("unit")}
            name="unitId"
            type="number"
            min={0}
            max={255}
            className="zf-input mono"
            defaultValue={entry.link.unitId}
            disabled={pending}
          />
        </Field>
        <Field label="Server port" htmlFor={id("port")}>
          <input
            id={id("port")}
            name="serverPort"
            type="number"
            min={1}
            max={65535}
            className="zf-input mono"
            defaultValue={entry.link.serverPort}
            disabled={pending}
          />
        </Field>
      </div>
      <Result state={state} pending={pending} />
      <div>
        <button type="submit" className="zf-btn" data-size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

export function NewLinkForm({ view, action }: { view: PlcCommunicationView; action: Action }) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  if (view.peers.length === 0) {
    return <p className="zf-sub">This factory has no other programmable controller to link to.</p>;
  }
  return (
    <form action={formAction} className="flex flex-col gap-1.5" aria-label="New link">
      <div className="grid grid-cols-4 gap-2.5">
        <Field label="Link to" htmlFor="link-peer">
          <select id="link-peer" name="peerId" className="zf-input mono" disabled={pending}>
            {view.peers.map((peer) => (
              <option key={peer.plcId} value={peer.plcId}>
                {`${peer.name}${peer.servesModbus ? "" : " (does not serve Modbus TCP)"}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Relationship" htmlFor="link-relationship">
          <select
            id="link-relationship"
            name="relationship"
            className="zf-input"
            defaultValue="SUPERVISES"
            disabled={pending}
          >
            <option value="SUPERVISES">this PLC supervises it</option>
            <option value="COMMUNICATES_WITH">this PLC communicates with it</option>
          </select>
        </Field>
        <Field label="This PLC is" htmlFor="link-role">
          <select id="link-role" name="role" className="zf-input" defaultValue="client" disabled={pending}>
            <option value="client">the client (it reads and writes the other)</option>
            <option value="server">the server (the other reads and writes it)</option>
          </select>
        </Field>
        <Field label="Poll interval (ms)" htmlFor="link-poll">
          <input
            id="link-poll"
            name="pollIntervalMs"
            type="number"
            min={50}
            max={60000}
            defaultValue={1000}
            className="zf-input mono"
            disabled={pending}
          />
        </Field>
      </div>
      <p className="zf-sub">
        Modbus TCP over the factory network: the server is reached by its service name, port 502, unit 1.
      </p>
      <Result state={state} pending={pending} />
      <div>
        <button type="submit" className="zf-btn" data-variant="primary" data-size="sm" disabled={pending}>
          {pending ? "Linking…" : "Create link"}
        </button>
      </div>
    </form>
  );
}
