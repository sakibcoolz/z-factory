"use client";

import Link from "next/link";
import { useState } from "react";
import { type WiringActions, WiringEditor } from "@/components/canvas/wiring-editor";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import type { TopologyEdgeView, TopologyNodeView } from "@/lib/domain/topology-view";
import { edgeLabel, edgesOf, nodeKind, RELATIONSHIP_LABELS } from "@/lib/topology/flow";

export type InspectorSelection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  /** Two devices being wired pin by pin, before the first wire between them exists. */
  | { kind: "pair"; firstId: string; secondId: string }
  | undefined;

type TopologyInspectorProps = {
  nodes: readonly TopologyNodeView[];
  edges: readonly TopologyEdgeView[];
  selection: InspectorSelection;
  readOnly: boolean;
  busy: boolean;
  /** PLC screens by device id. */
  plcLinks: Readonly<Record<string, string>>;
  onRename: (deviceId: string, input: { name: string; role: string }) => void;
  onRemoveDevice: (deviceId: string) => void;
  onRemoveEdge: (edge: TopologyEdgeView) => void;
  /**
   * Connects the selected device to another, as drawing between their handles does
   * (TASK-1008): for keyboard users and browser agents, which cannot drag.
   */
  onConnect?: (fromId: string, toId: string) => void;
  /** Pin-to-pin wiring; absent in the read-only view. */
  wiring?: WiringActions;
  /** Called after a wire was added, moved or removed. */
  onWiringChanged: () => void;
};

const mono = (value: string) => (
  <span key="v" className="mono text-fg-strong">
    {value}
  </span>
);

function EdgeRow({
  edge,
  name,
  onRemove,
}: {
  edge: TopologyEdgeView;
  name: (id: string) => string;
  onRemove?: () => void;
}) {
  return (
    <li className="flex items-start justify-between gap-2 px-2.5 py-1">
      <span className="mono whitespace-normal">{`${name(edge.sourceId)} ${edgeLabel(edge)} ${name(edge.targetId)}`}</span>
      {onRemove ? (
        <button
          type="button"
          className="zf-btn"
          data-variant="ghost"
          data-size="sm"
          onClick={onRemove}
          aria-label={`Remove ${RELATIONSHIP_LABELS[edge.relationship]} ${name(edge.sourceId)} to ${name(edge.targetId)}`}
        >
          ✕
        </button>
      ) : null}
    </li>
  );
}

/** 2d — inspector: the selected device or connection, with the edits the designer allows. */
export function TopologyInspector(props: TopologyInspectorProps) {
  const { nodes, edges, selection, readOnly, busy } = props;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const name = (id: string) => nodes.find((node) => node.id === id)?.name ?? "?";

  if (selection?.kind === "pair") {
    return (
      <div className="flex flex-col gap-2 p-2.5">
        <span className="zf-k">Wiring</span>
        <KeyValue
          rows={[
            ["Between", mono(name(selection.firstId))],
            ["And", mono(name(selection.secondId))],
          ]}
        />
        {props.wiring ? (
          <WiringEditor
            key={`${selection.firstId}:${selection.secondId}`}
            firstId={selection.firstId}
            secondId={selection.secondId}
            actions={props.wiring}
            onChanged={props.onWiringChanged}
          />
        ) : null}
      </div>
    );
  }

  if (selection?.kind === "edge") {
    const edge = edges.find((candidate) => candidate.id === selection.id);
    if (!edge) return <p className="zf-sub p-2.5">This connection no longer exists.</p>;
    if (edge.plcLink) {
      return (
        <div className="flex flex-col gap-2 p-2.5">
          <span className="zf-k">PLC link</span>
          <KeyValue
            rows={[
              ["Client", mono(name(edge.sourceId))],
              ["Relationship", edge.plcLink.relationship === "SUPERVISES" ? "supervises" : "communicates with"],
              ["Server", mono(name(edge.targetId))],
              ["Protocol", "Modbus TCP"],
              ["Values", edge.plcLink.enabled ? String(edge.plcLink.values) : "disabled"],
            ]}
          />
          <a className="zf-btn" data-size="sm" href={edge.plcLink.href}>
            Open on the Communication screen
          </a>
          <p className="zf-sub">
            The client reads and writes the server through its own runtime. Writes reach the server&apos;s command and
            setpoint tags; the server&apos;s program decides.
          </p>
        </div>
      );
    }
    const wired = edge.relationship === "WIRED_TO";
    return (
      <div className="flex flex-col gap-2 p-2.5">
        <span className="zf-k">{wired ? "Wiring" : "Connection"}</span>
        <KeyValue
          rows={[
            ["From", mono(name(edge.sourceId))],
            ["Relationship", RELATIONSHIP_LABELS[edge.relationship]],
            ["To", mono(name(edge.targetId))],
            ...(edge.protocol ? ([["Protocol", edge.protocol.replace("MODBUS_TCP", "Modbus TCP")]] as const) : []),
          ]}
        />
        {wired && props.wiring && !readOnly ? (
          <WiringEditor
            key={edge.id}
            firstId={edge.sourceId}
            secondId={edge.targetId}
            actions={props.wiring}
            revision={edge.wires.map((wire) => wire.id).join(",")}
            onChanged={props.onWiringChanged}
          />
        ) : edge.wires.length > 0 ? (
          <ul className="mono flex flex-col gap-1 text-xs">
            {edge.wires.map((wire) => (
              <li key={wire.id} className="whitespace-normal">
                {`${wire.from.name} → ${wire.to.name}${wire.logicalAddress ? ` · ${wire.logicalAddress}` : ""}`}
              </li>
            ))}
          </ul>
        ) : null}
        {!readOnly ? (
          <>
            <button
              type="button"
              className="zf-btn"
              data-variant="danger"
              data-size="sm"
              disabled={busy}
              onClick={() => props.onRemoveEdge(edge)}
            >
              {wired ? "Remove all wires" : "Remove connection"}
            </button>
            {wired ? (
              <p className="zf-sub">
                Removes every wire between these two devices. PLC channels are free again and their tags are removed.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  const node = selection?.kind === "node" ? nodes.find((candidate) => candidate.id === selection.id) : undefined;
  if (!node) {
    return (
      <p className="zf-sub p-2.5">
        {readOnly
          ? "Select a device or a connection to see its details."
          : "Drag a model from the palette onto the canvas. Draw from one device's handle to another to connect them. Select a device or connection to edit it."}
      </p>
    );
  }
  const connections = edgesOf(node.id, edges);
  const plcHref = props.plcLinks[node.id];
  const others = nodes.filter((candidate) => candidate.id !== node.id);

  return (
    <div className="flex flex-col gap-2 p-2.5">
      <KeyValue
        rows={[
          ["Instance", mono(node.name)],
          ["Role", node.role ?? "—"],
          ["Type", nodeKind(node)],
          ["Model", `${node.manufacturer} ${node.modelName}`],
          ["State", <RuntimeStatePill key="v" state={node.runtimeStatus} />],
        ]}
      />
      {plcHref ? (
        <Link href={plcHref} className="zf-btn" data-size="sm">
          {node.architectureType ? "Open PLC" : "Open device"}
        </Link>
      ) : null}
      {!readOnly ? (
        <form
          // Remounts with fresh defaults when another device is selected or this one is renamed.
          key={`${node.id}:${node.name}:${node.role ?? ""}`}
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            props.onRename(node.id, { name: String(data.get("name") ?? ""), role: String(data.get("role") ?? "") });
          }}
        >
          <label htmlFor="inspector-name" className="zf-k">
            Name
          </label>
          <input
            id="inspector-name"
            name="name"
            className="zf-input mono"
            defaultValue={node.name}
            maxLength={63}
            required
          />
          <label htmlFor="inspector-role" className="zf-k">
            Role
          </label>
          <input id="inspector-role" name="role" className="zf-input" defaultValue={node.role ?? ""} maxLength={120} />
          <button type="submit" className="zf-btn" data-size="sm" disabled={busy}>
            Save name and role
          </button>
        </form>
      ) : null}
      <span className="zf-k">{`Connections (${connections.length})`}</span>
      {connections.length > 0 ? (
        <ul>
          {connections.map((edge) => (
            <EdgeRow
              key={edge.id}
              edge={edge}
              name={name}
              onRemove={readOnly || busy || edge.plcLink ? undefined : () => props.onRemoveEdge(edge)}
            />
          ))}
        </ul>
      ) : (
        <p className="zf-sub">Not connected.</p>
      )}
      {!readOnly && props.onConnect && others.length > 0 ? (
        <form
          key={`connect:${node.id}`}
          className="flex flex-col gap-1.5"
          aria-label={`Connect ${node.name} to another device`}
          onSubmit={(event) => {
            event.preventDefault();
            const to = String(new FormData(event.currentTarget).get("to") ?? "");
            if (to) props.onConnect?.(node.id, to);
          }}
        >
          <label htmlFor="inspector-connect" className="zf-k">
            Connect to
          </label>
          <span className="flex gap-1.5">
            <select id="inspector-connect" name="to" className="zf-input mono min-w-0 flex-1" disabled={busy}>
              {others.map((other) => (
                <option key={other.id} value={other.id}>
                  {`${other.name} · ${nodeKind(other)}`}
                </option>
              ))}
            </select>
            <button type="submit" className="zf-btn" data-size="sm" disabled={busy}>
              Connect
            </button>
          </span>
          <p className="zf-sub">
            The same as drawing from this device&apos;s handle to the other: the canvas offers the relationships the two
            allow, or opens pin-to-pin wiring.
          </p>
        </form>
      ) : null}
      {readOnly ? null : confirmingDelete ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="zf-error whitespace-normal" role="alert">{`Delete ${node.name} and its connections?`}</span>
          <button
            type="button"
            className="zf-btn"
            data-variant="danger"
            data-size="sm"
            disabled={busy}
            onClick={() => {
              setConfirmingDelete(false);
              props.onRemoveDevice(node.id);
            }}
          >
            Confirm delete
          </button>
          <button
            type="button"
            className="zf-btn"
            data-variant="ghost"
            data-size="sm"
            onClick={() => setConfirmingDelete(false)}
          >
            Keep
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="zf-btn"
          data-variant="ghost"
          data-size="sm"
          onClick={() => setConfirmingDelete(true)}
        >
          Delete device
        </button>
      )}
    </div>
  );
}
