/**
 * Shapes the topology service returns and the designer canvas renders
 * (docs/design.md → Factory Designer). Pure types; importable anywhere.
 * Devices are identified by their Z-Factory ids; nothing here carries a Docker id.
 */
import type { ConnectionRelationship, PlcArchitecture } from "@/lib/domain/device";
import type { RuntimeState } from "@/lib/domain/runtime-state";

export type TopologyNodeView = {
  id: string;
  /** Instance name, unique within the factory. */
  name: string;
  role: string | null;
  categoryCode: string;
  categoryName: string;
  manufacturer: string;
  modelName: string;
  architectureType: PlcArchitecture | null;
  runtimeStatus: RuntimeState;
  x: number;
  y: number;
  /** False while the position is only the default grid slot. */
  placed: boolean;
};

export type TopologyWireView = {
  terminalLabel: string | null;
  pointLabel: string;
  logicalAddress: string;
  tagName: string | null;
};

/** One typed edge: every connection of one relationship between two devices. */
export type TopologyEdgeView = {
  id: string;
  relationship: ConnectionRelationship;
  sourceId: string;
  targetId: string;
  /** Wires through PLC I/O channels; empty for device-level and protocol links. */
  wires: TopologyWireView[];
  protocol: string | null;
};

export type PaletteGroupView = {
  categoryCode: string;
  categoryName: string;
  items: Array<{ modelId: string; modelName: string; manufacturer: string; architectureType: PlcArchitecture | null }>;
};

export type TopologyView = {
  factory: { id: string; name: string; slug: string; runtimeStatus: RuntimeState };
  nodes: TopologyNodeView[];
  edges: TopologyEdgeView[];
  palette: PaletteGroupView[];
};

/** Result of asking for a link: made, or a choice between several possible relationships. */
export type LinkResult = { status: "LINKED" } | { status: "CHOOSE"; options: Array<{ kind: string; label: string }> };
