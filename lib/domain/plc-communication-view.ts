/**
 * What the PLC Communication screen shows (TASK-704). Pure types; importable anywhere.
 * Everything comes from the link service, the mapping rules and the link monitor.
 */
import type { PlcLinkMappingView, PlcLinkOperation, PlcLinkView } from "@/lib/domain/plc-communication";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { TagDataType } from "@/lib/domain/tag";

export type LinkPeer = {
  plcId: string;
  name: string;
  runtimeStatus: RuntimeState;
  /** The peer's model serves Modbus TCP, so this PLC can be its client. */
  servesModbus: boolean;
};

/** A tag of one end as a picker option: refused ones say why. */
export type LinkTagOption = {
  tagId: string;
  name: string;
  logicalAddress: string | null;
  dataType: TagDataType;
  unit: string | null;
  scale: number;
  refusal: string | null;
};

export type LinkHealthView = {
  quality: "GOOD" | "STALE" | "DISCONNECTED";
  reason: string | null;
  since: string;
  checkedAt: string;
};

export type CommunicationLinkView = {
  link: PlcLinkView;
  /** This PLC's protocol role on the link. */
  role: "client" | "server";
  peer: { plcId: string; name: string };
  /** Null while the link is not watched (the factory is not started). */
  health: LinkHealthView | null;
  /** The link version the client's runtime was last deployed with; null when never. */
  deployedVersion: number | null;
  mappings: PlcLinkMappingView[];
  /** Picker options per operation, for the client side only: this PLC's tags and the server's. */
  options: Record<PlcLinkOperation, { local: LinkTagOption[]; remote: LinkTagOption[] }> | null;
};

export type PlcCommunicationView = {
  plcId: string;
  factoryId: string;
  peers: LinkPeer[];
  links: CommunicationLinkView[];
  /** The factory's links are being watched (the factory has been started). */
  watched: boolean;
};
