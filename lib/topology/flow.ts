/**
 * Maps the topology view onto what the canvas draws. Pure; importable anywhere.
 */
import type { ConnectionRelationship } from "@/lib/domain/device";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { TopologyEdgeView, TopologyNodeView } from "@/lib/domain/topology-view";

export const RELATIONSHIP_LABELS: Record<ConnectionRelationship, string> = {
  CONTROLS: "controls",
  DRIVES: "drives",
  MECHANICALLY_DRIVES: "mechanically drives",
  MEASURES: "measures",
  FEEDS_BACK_TO: "feeds back to",
  COMMUNICATES_WITH: "communicates with",
  WIRED_TO: "wired to",
};

/** How an edge is drawn: plain signal, network link or feedback. */
export type EdgeLine = "signal" | "network" | "feedback";

export function edgeLine(relationship: ConnectionRelationship): EdgeLine {
  if (relationship === "COMMUNICATES_WITH") return "network";
  return relationship === "FEEDS_BACK_TO" || relationship === "MEASURES" ? "feedback" : "signal";
}

/** Overlay of an edge from the state of its two ends: a fault wins, activity needs both running. */
export type EdgeTone = "idle" | "active" | "fault";

export function edgeTone(source: RuntimeState | undefined, target: RuntimeState | undefined): EdgeTone {
  if (source === "FAULTED" || target === "FAULTED") return "fault";
  return source === "RUNNING" && target === "RUNNING" ? "active" : "idle";
}

/** `controls · 3 wires`, `communicates with · Modbus TCP`, `drives` */
export function edgeLabel(edge: Pick<TopologyEdgeView, "relationship" | "wires" | "protocol">): string {
  const parts = [RELATIONSHIP_LABELS[edge.relationship]];
  if (edge.wires.length > 0) parts.push(`${edge.wires.length} wire${edge.wires.length === 1 ? "" : "s"}`);
  else if (edge.protocol) parts.push(edge.protocol.replace("MODBUS_TCP", "Modbus TCP"));
  return parts.join(" · ");
}

/** Second line of a node: what kind of device it is. */
export function nodeKind(node: Pick<TopologyNodeView, "categoryName" | "architectureType">): string {
  return node.architectureType
    ? `PLC · ${node.architectureType.toLowerCase()}`
    : (node.categoryName.split(" / ")[0] ?? node.categoryName);
}

/** Edges that touch a device, for the inspector. */
export function edgesOf(deviceId: string, edges: readonly TopologyEdgeView[]): TopologyEdgeView[] {
  return edges.filter((edge) => edge.sourceId === deviceId || edge.targetId === deviceId);
}

/** Whether anything is running, so the canvas knows to refresh its state overlay. */
export function hasActivity(nodes: ReadonlyArray<Pick<TopologyNodeView, "runtimeStatus">>): boolean {
  return nodes.some((node) => node.runtimeStatus !== "STOPPED");
}
