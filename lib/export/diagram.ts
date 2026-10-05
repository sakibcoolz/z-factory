/**
 * Layout of the topology diagram in the printed report: canvas positions scaled into a
 * fixed drawing area. Pure.
 */
import type { PlcExportDocument } from "@/lib/export/plc-export";

export const DIAGRAM_NODE = { width: 132, height: 38 } as const;

export type DiagramLayout = {
  width: number;
  height: number;
  nodes: Array<{ id: string; name: string; kind: string; x: number; y: number }>;
  edges: Array<{ x1: number; y1: number; x2: number; y2: number; label: string; dashed: boolean }>;
};

export function layoutDiagram(topology: PlcExportDocument["topology"], width = 720, height = 300): DiagramLayout {
  const { nodes, edges } = topology;
  if (nodes.length === 0) return { width, height, nodes: [], edges: [] };
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const spanX = Math.max(...xs) - minX || 1;
  const spanY = Math.max(...ys) - minY || 1;
  // Keep the aspect ratio and leave room for the node boxes.
  const scale = Math.min((width - DIAGRAM_NODE.width - 16) / spanX, (height - DIAGRAM_NODE.height - 16) / spanY, 1);
  const placed = nodes.map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    x: Math.round(8 + (node.x - minX) * scale),
    y: Math.round(8 + (node.y - minY) * scale),
  }));
  const center = new Map(
    placed.map((node) => [node.id, { x: node.x + DIAGRAM_NODE.width / 2, y: node.y + DIAGRAM_NODE.height / 2 }]),
  );
  return {
    width,
    height,
    nodes: placed,
    edges: edges.flatMap((edge) => {
      const [from, to] = [center.get(edge.sourceId), center.get(edge.targetId)];
      if (!from || !to) return [];
      return [
        {
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          label: edge.label,
          dashed:
            edge.relationship === "COMMUNICATES_WITH" ||
            edge.relationship === "FEEDS_BACK_TO" ||
            edge.relationship === "MEASURES",
        },
      ];
    }),
  };
}
