"use client";

import "@xyflow/react/dist/style.css";
import { RefusalExplanation } from "@/components/ui/refusal";
import type { ValidationExplanation } from "@/lib/domain/validation-explanations";
import {
  Background,
  BaseEdge,
  type Connection,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useRouter } from "next/navigation";
import { type DragEvent, useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { PALETTE_MIME } from "@/components/canvas/device-palette";
import { type InspectorSelection, TopologyInspector } from "@/components/canvas/topology-inspector";
import type { WiringActions } from "@/components/canvas/wiring-editor";
import { SideBar } from "@/components/shell/side-bar";
import { RuntimeStatePill, runtimeStateTone } from "@/components/ui/state-pill";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { LinkResult, TopologyEdgeView, TopologyNodeView, TopologyView } from "@/lib/domain/topology-view";
import { edgeLabel, edgeLine, edgeTone, hasActivity, nodeKind } from "@/lib/topology/flow";

type Result<T = undefined> =
  { ok: true; value: T } | { ok: false; message: string; explanation?: ValidationExplanation };

/** Server actions the canvas calls. Absent in the read-only topology view. */
export type CanvasActions = {
  place: (input: { deviceModelId: string; x: number; y: number }) => Promise<Result<{ id: string; name: string }>>;
  move: (positions: Array<{ deviceId: string; x: number; y: number }>) => Promise<Result>;
  link: (input: { fromId: string; toId: string; kind?: string }) => Promise<Result<LinkResult>>;
  unlink: (input: { sourceId: string; targetId: string; relationship: string }) => Promise<Result>;
  remove: (deviceId: string) => Promise<Result>;
  rename: (deviceId: string, input: { name: string; role: string }) => Promise<Result>;
  /** Pin-to-pin wiring of two devices. */
  wiring: WiringActions;
};

type TopologyCanvasProps = {
  view: Pick<TopologyView, "nodes" | "edges">;
  actions?: CanvasActions;
  /** PLC screens by device id. */
  plcLinks: Readonly<Record<string, string>>;
};

type DeviceNodeData = { name: string; kind: string; model: string; state: RuntimeState };
type DeviceNode = Node<DeviceNodeData, "device">;

/** A device on the canvas: its unique instance name, what it is, and its runtime state. */
function DeviceNodeView({ data, selected, isConnectable }: NodeProps<DeviceNode>) {
  const tone = runtimeStateTone(data.state);
  return (
    <div className="zf-node" data-tone={tone === "run" || tone === "flt" ? tone : undefined} data-selected={selected}>
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
      <div className="zf-node-head">
        {data.name}
        <RuntimeStatePill state={data.state} dot />
      </div>
      <div className="zf-node-body">
        <span>{data.kind}</span>
        <span>{data.model}</span>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
    </div>
  );
}

type TypedEdge = Edge<{ label: string; shift: number }, "typed">;

/** A typed connection. Its label is shifted when another edge runs between the same two devices. */
function TypedEdgeView(props: EdgeProps<TypedEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} />
      <EdgeLabelRenderer>
        <div
          className="zf-edge-label"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (props.data?.shift ?? 0)}px)` }}
        >
          {props.data?.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { device: DeviceNodeView };
const edgeTypes = { typed: TypedEdgeView };

const toFlowNode = (node: TopologyNodeView): DeviceNode => ({
  id: node.id,
  type: "device",
  position: { x: node.x, y: node.y },
  data: { name: node.name, kind: nodeKind(node), model: node.modelName, state: node.runtimeStatus },
});

function toFlowEdges(view: Pick<TopologyView, "nodes" | "edges">): TypedEdge[] {
  const state = new Map(view.nodes.map((node) => [node.id, node.runtimeStatus]));
  const pair = (edge: TopologyEdgeView) => [edge.sourceId, edge.targetId].sort().join("|");
  const seen = new Map<string, number>();
  return view.edges.map((edge) => {
    const tone = edgeTone(state.get(edge.sourceId), state.get(edge.targetId));
    // Edges between the same two devices would stack their labels: space them out.
    const index = seen.get(pair(edge)) ?? 0;
    seen.set(pair(edge), index + 1);
    return {
      id: edge.id,
      type: "typed",
      source: edge.sourceId,
      target: edge.targetId,
      data: { label: edgeLabel(edge), shift: index * 18 },
      animated: tone === "active",
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      domAttributes: { "data-line": edgeLine(edge.relationship), "data-tone": tone } as TypedEdge["domAttributes"],
    };
  });
}

function Canvas({ view, actions, plcLinks }: TopologyCanvasProps) {
  const router = useRouter();
  const flow = useReactFlow();
  const readOnly = !actions;
  const [nodes, setNodes, onNodesChange] = useNodesState<DeviceNode>(view.nodes.map(toFlowNode));
  const [selection, setSelection] = useState<InspectorSelection>();
  const [notice, setNotice] = useState<{ message: string; explanation?: ValidationExplanation }>();
  const [choice, setChoice] = useState<{
    fromId: string;
    toId: string;
    options: Array<{ kind: string; label: string }>;
  }>();
  const [busy, startTransition] = useTransition();
  const edges = useMemo(() => toFlowEdges(view), [view]);

  // The server is the source of truth: after every change the view is loaded again.
  useEffect(() => setNodes(view.nodes.map(toFlowNode)), [view.nodes, setNodes]);

  // While something runs, reload so the state overlay follows the persisted runtime state.
  const active = hasActivity(view.nodes);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, router]);

  /** Runs a server action; shows its error, or reloads the view on success. */
  const perform = useCallback(
    <T,>(work: () => Promise<Result<T>>, done?: (value: T) => void) =>
      startTransition(async () => {
        const result = await work();
        if (!result.ok) {
          setNotice({ message: result.message, explanation: result.explanation });
          // Put nodes back where the server has them, e.g. after a refused connection.
          router.refresh();
          return;
        }
        setNotice(undefined);
        done?.(result.value);
        router.refresh();
      }),
    [router],
  );

  const link = useCallback(
    (fromId: string, toId: string, kind?: string) => {
      if (!actions) return;
      perform(
        () => actions.link({ fromId, toId, kind }),
        (result) => {
          setChoice(result.status === "CHOOSE" ? { fromId, toId, options: result.options } : undefined);
          // Wiring is done pin by pin in the inspector: on the edge when there is one, else for the pair.
          if (result.status !== "WIRE") return;
          const edge = view.edges.find(
            (candidate) =>
              candidate.relationship === "WIRED_TO" &&
              [candidate.sourceId, candidate.targetId].includes(result.firstId) &&
              [candidate.sourceId, candidate.targetId].includes(result.secondId),
          );
          setSelection(
            edge ? { kind: "edge", id: edge.id } : { kind: "pair", firstId: result.firstId, secondId: result.secondId },
          );
        },
      );
    },
    [actions, perform, view.edges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) link(connection.source, connection.target);
    },
    [link],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      const deviceModelId = event.dataTransfer.getData(PALETTE_MIME);
      if (!actions || !deviceModelId) return;
      event.preventDefault();
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      perform(
        () => actions.place({ deviceModelId, x: Math.round(position.x), y: Math.round(position.y) }),
        (device) => setSelection({ kind: "node", id: device.id }),
      );
    },
    [actions, flow, perform],
  );

  const removeEdge = (edge: TopologyEdgeView) => {
    // A PLC link is changed on the PLC's Communication screen, not on the canvas.
    if (!actions || edge.plcLink) return;
    perform(
      () => actions.unlink({ sourceId: edge.sourceId, targetId: edge.targetId, relationship: edge.relationship }),
      () => setSelection(undefined),
    );
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="zf-flow" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        {notice ? (
          <div className="zf-error zf-flow-notice" role="alert">
            <p>{notice.message}</p>
            {notice.explanation ? <RefusalExplanation explanation={notice.explanation} className="mt-1" /> : null}
          </div>
        ) : null}
        {choice ? (
          <div className="zf-cell zf-flow-notice" role="dialog" aria-label="Choose the relationship">
            <span className="zf-k">How are these two connected?</span>
            {choice.options.map((option) => (
              <button
                key={option.kind}
                type="button"
                className="zf-btn"
                data-size="sm"
                disabled={busy}
                onClick={() => link(choice.fromId, choice.toId, option.kind)}
              >
                {option.label}
              </button>
            ))}
            <button
              type="button"
              className="zf-btn"
              data-variant="ghost"
              data-size="sm"
              onClick={() => setChoice(undefined)}
            >
              Cancel
            </button>
          </div>
        ) : null}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="dark"
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelection({ kind: "node", id: node.id })}
          onEdgeClick={(_, edge) => setSelection({ kind: "edge", id: edge.id })}
          onPaneClick={() => setSelection(undefined)}
          onNodeDragStop={(_, _node, dragged) => {
            if (!actions) return;
            perform(() =>
              actions.move(
                dragged.map((node) => ({
                  deviceId: node.id,
                  x: Math.round(node.position.x),
                  y: Math.round(node.position.y),
                })),
              ),
            );
          }}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          // Deleting is an explicit, confirmed action in the inspector, never a key press.
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          aria-label="Factory canvas"
        >
          <Background gap={32} size={0} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <SideBar title="Inspector" edge="left" className="w-72">
        <TopologyInspector
          nodes={view.nodes}
          edges={view.edges}
          selection={selection}
          readOnly={readOnly}
          busy={busy}
          plcLinks={plcLinks}
          onRename={(deviceId, input) => actions && perform(() => actions.rename(deviceId, input))}
          onRemoveDevice={(deviceId) =>
            actions &&
            perform(
              () => actions.remove(deviceId),
              () => setSelection(undefined),
            )
          }
          onRemoveEdge={removeEdge}
          wiring={actions?.wiring}
          onWiringChanged={() => router.refresh()}
        />
      </SideBar>
    </div>
  );
}

/**
 * 2d / 2o — the factory topology on a canvas: devices as nodes with their unique names,
 * typed connections as edges, and the runtime state laid over both. With `actions` it is
 * the designer; without, a read-only view.
 */
export function TopologyCanvas(props: TopologyCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
