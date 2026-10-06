/**
 * Shapes the topology service returns and the designer canvas renders
 * (docs/design.md → Factory Designer). Pure types; importable anywhere.
 * Devices are identified by their Z-Factory ids; nothing here carries a Docker id.
 */
import type { ConnectionRelationship, PlcArchitecture } from "@/lib/domain/device";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { WireView } from "@/lib/domain/wiring-view";

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

/**
 * One logical edge between two devices. Every wire between two devices is one edge
 * (`WIRED_TO`), however many wires there are; a relationship that is not wiring (drives,
 * measures, communicates with, …) is an edge of its own.
 */
export type TopologyEdgeView = {
  id: string;
  relationship: ConnectionRelationship;
  sourceId: string;
  targetId: string;
  /** The physical wires of a wiring edge, pin to pin; empty for every other edge. */
  wires: WireView[];
  protocol: string | null;
  /** A PLC-to-PLC link (Phase 07): configured on the PLC's Communication screen, never on the canvas. */
  plcLink?: {
    linkId: string;
    relationship: "COMMUNICATES_WITH" | "SUPERVISES";
    /** Values carried over the link. */
    values: number;
    enabled: boolean;
    /** The client PLC's Communication screen. */
    href: string;
  };
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

/**
 * Result of asking for a link: made, a choice between several possible relationships, or
 * `WIRE`: the two devices are wired pin by pin, and nothing is stored until a wire is.
 */
export type LinkResult =
  | { status: "LINKED" }
  | { status: "CHOOSE"; options: Array<{ kind: string; label: string }> }
  | { status: "WIRE"; firstId: string; secondId: string };
