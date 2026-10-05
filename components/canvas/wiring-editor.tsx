"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { PairWiringView, WireView, WiringEndpointView } from "@/lib/domain/wiring-view";

type Result<T = undefined> = { ok: true; value: T } | { ok: false; message: string };
type WireInput = {
  from: { deviceId: string; type: string; id: string };
  to: { deviceId: string; type: string; id: string };
};

/** Server actions of the wiring editor. */
export type WiringActions = {
  load: (firstId: string, secondId: string, replacingWireId?: string) => Promise<Result<PairWiringView>>;
  connect: (input: WireInput) => Promise<Result<{ wireId: string }>>;
  reconnect: (wireId: string, input: WireInput) => Promise<Result<{ wireId: string }>>;
  disconnect: (wireId: string) => Promise<Result>;
};

type WiringEditorProps = {
  firstId: string;
  secondId: string;
  actions: WiringActions;
  /** Changes when the wiring changed elsewhere, so the editor loads it again. */
  revision?: string;
  /** Called after a wire was added, moved or removed. */
  onChanged: () => void;
};

const optionText = (endpoint: WiringEndpointView) =>
  [
    endpoint.label,
    endpoint.summary,
    endpoint.wires.length > 0 ? `${endpoint.wires.length} of ${endpoint.maxConnections} wired` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** The first endpoint of the first device that still has somewhere to go, and where. */
function suggest(view: PairWiringView): { from: string; to: string } {
  const free = (from: WiringEndpointView) =>
    view.second.endpoints.find((to) => view.refusals[from.key]?.[to.key] === undefined);
  const from = view.first.endpoints.find((candidate) => free(candidate)) ?? view.first.endpoints[0];
  return { from: from?.key ?? "", to: (from && free(from)?.key) ?? view.second.endpoints[0]?.key ?? "" };
}

const wireText = (wire: WireView) => `${wire.from.name} → ${wire.to.name}`;

/**
 * Wires two devices pin by pin. It lists the wires between them, and offers one wire at
 * a time between an exact endpoint of each. A destination the rules refuse is named with
 * the reason and cannot be saved; the server checks again when a wire is stored.
 */
export function WiringEditor({ firstId, secondId, actions, revision, onChanged }: WiringEditorProps) {
  const [view, setView] = useState<PairWiringView>();
  const [error, setError] = useState<string>();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [replacing, setReplacing] = useState<WireView>();
  const [version, setVersion] = useState(0);
  const [pending, startTransition] = useTransition();

  const replacingId = replacing?.id;
  useEffect(() => {
    let current = true;
    void actions.load(firstId, secondId, replacingId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setView(undefined);
        setError(result.message);
        return;
      }
      setView(result.value);
      const moved = result.value.wires.find((wire) => wire.id === replacingId);
      if (moved) {
        // Start from where the wire is now.
        const [own, other] = moved.from.deviceId === firstId ? [moved.from, moved.to] : [moved.to, moved.from];
        setFrom(`${own.type}:${own.endpointId}`);
        setTo(`${other.type}:${other.endpointId}`);
      } else {
        const suggestion = suggest(result.value);
        setFrom(suggestion.from);
        setTo(suggestion.to);
      }
    });
    return () => {
      current = false;
    };
  }, [actions, firstId, secondId, replacingId, revision, version]);

  const perform = useCallback(
    (work: () => Promise<Result<unknown>>) =>
      startTransition(async () => {
        const result = await work();
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setError(undefined);
        setReplacing(undefined);
        setVersion((value) => value + 1);
        onChanged();
      }),
    [onChanged],
  );

  if (!view) {
    return error ? (
      <p className="zf-error whitespace-normal" role="alert">
        {error}
      </p>
    ) : (
      <p className="zf-sub">Loading the endpoints…</p>
    );
  }

  const { first, second } = view;
  const endpoint = (side: typeof first, key: string) => side.endpoints.find((candidate) => candidate.key === key);
  const [fromEndpoint, toEndpoint] = [endpoint(first, from), endpoint(second, to)];
  const refusal = view.refusals[from]?.[to];
  const possible = (key: string) => view.refusals[from]?.[key] === undefined;
  const anyPossible = first.endpoints.some((a) =>
    second.endpoints.some((b) => view.refusals[a.key]?.[b.key] === undefined),
  );
  const submit = () => {
    if (!fromEndpoint || !toEndpoint || refusal) return;
    const input = {
      from: { deviceId: first.deviceId, type: fromEndpoint.type, id: fromEndpoint.id },
      to: { deviceId: second.deviceId, type: toEndpoint.type, id: toEndpoint.id },
    };
    perform(() => (replacing ? actions.reconnect(replacing.id, input) : actions.connect(input)));
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="zf-k">{`Wires · ${view.wires.length}`}</span>
      {view.wires.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {view.wires.map((wire) => (
            <li key={wire.id} className="flex flex-col gap-1" data-selected={wire.id === replacingId}>
              <span className="mono text-xs whitespace-normal">{wireText(wire)}</span>
              {wire.logicalAddress ? (
                <span className="mono text-xs text-fg-dim">{`${wire.logicalAddress} · ${wire.tagName ?? "no tag"}`}</span>
              ) : null}
              <span className="flex gap-1.5">
                <button
                  type="button"
                  className="zf-btn"
                  data-variant="ghost"
                  data-size="sm"
                  disabled={pending}
                  aria-label={`Move the wire ${wireText(wire)}`}
                  onClick={() => setReplacing(wire)}
                >
                  Move
                </button>
                <button
                  type="button"
                  className="zf-btn"
                  data-variant="ghost"
                  data-size="sm"
                  disabled={pending}
                  aria-label={`Remove the wire ${wireText(wire)}`}
                  onClick={() => perform(() => actions.disconnect(wire.id))}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="zf-sub">No wire between these two devices yet. Connecting them wires nothing by itself.</p>
      )}

      {first.endpoints.length === 0 || second.endpoints.length === 0 ? (
        <p className="zf-sub">{`${first.endpoints.length === 0 ? first.name : second.name} has no terminal to wire.`}</p>
      ) : (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <span className="zf-k">{replacing ? `Move ${wireText(replacing)}` : "Add a wire"}</span>
          {anyPossible ? null : (
            <p className="zf-sub">
              Nothing more can be wired between these two as they are. Choose two endpoints to see why.
            </p>
          )}
          <label htmlFor="wire-from" className="zf-k">{`${first.name} endpoint`}</label>
          <select
            id="wire-from"
            className="zf-input mono"
            value={from}
            disabled={pending}
            onChange={(event) => {
              const key = event.target.value;
              setFrom(key);
              // Offer the first destination this endpoint can go to.
              const next = second.endpoints.find((candidate) => view.refusals[key]?.[candidate.key] === undefined);
              if (next) setTo(next.key);
              setError(undefined);
            }}
          >
            {first.endpoints.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {optionText(candidate)}
              </option>
            ))}
          </select>
          <label htmlFor="wire-to" className="zf-k">{`${second.name} endpoint`}</label>
          <select
            id="wire-to"
            className="zf-input mono"
            value={to}
            disabled={pending}
            onChange={(event) => {
              setTo(event.target.value);
              setError(undefined);
            }}
          >
            {second.endpoints.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {`${optionText(candidate)}${possible(candidate.key) ? "" : " · not possible"}`}
              </option>
            ))}
          </select>
          {refusal || error ? (
            <p className="zf-error whitespace-normal" role="alert">
              {refusal ?? error}
            </p>
          ) : null}
          <button type="submit" className="zf-btn" data-size="sm" disabled={pending || !!refusal}>
            {replacing ? "Move wire" : "Add wire"}
          </button>
          {replacing ? (
            <button
              type="button"
              className="zf-btn"
              data-variant="ghost"
              data-size="sm"
              disabled={pending}
              onClick={() => setReplacing(undefined)}
            >
              Keep it where it is
            </button>
          ) : null}
        </form>
      )}
    </div>
  );
}
