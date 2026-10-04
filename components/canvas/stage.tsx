import type { ReactNode } from "react";
import { RuntimeStatePill, runtimeStateTone } from "@/components/ui/state-pill";
import type { RuntimeState } from "@/lib/domain/runtime-state";

export type StageEdgeKind = "idle" | "ok" | "fault" | "network" | "feedback";

export type StageEdge = {
  /** SVG path in stage coordinates. */
  path: string;
  kind: StageEdgeKind;
};

export type StageNode = {
  /** Z-Factory device instance name, unique within the factory. */
  name: string;
  x: number;
  y: number;
  state: RuntimeState;
  lines: readonly string[];
  selected?: boolean;
  /** Device lives outside the factory Docker network (e.g. physical edge gateway). */
  external?: boolean;
  narrow?: boolean;
  emphasis?: boolean;
};

type StageProps = {
  width: number;
  height: number;
  label: string;
  nodes: readonly StageNode[];
  edges: readonly StageEdge[];
  /** Zones, legends and controls layered over the stage. */
  children?: ReactNode;
};

/**
 * Static canvas: nodes and edges share one coordinate system.
 * Interactive editing (React Flow) is owned by TASK-303.
 */
export function Stage({ width, height, label, nodes, edges, children }: StageProps) {
  return (
    <div className="zf-stage-wrap">
      <div className="zf-stage" style={{ width, height }} role="group" aria-label={label}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {edges.map((edge) => (
            <path key={edge.path} d={edge.path} className="zf-edge" data-kind={edge.kind} />
          ))}
        </svg>
        {children}
        {nodes.map((node) => {
          const tone = runtimeStateTone(node.state);
          return (
            <div
              key={node.name}
              className="zf-node"
              style={{ left: node.x, top: node.y }}
              data-tone={tone === "run" || tone === "flt" ? tone : undefined}
              data-selected={node.selected ?? false}
              data-external={node.external ?? false}
              data-emphasis={node.emphasis ?? false}
              data-size={node.narrow ? "narrow" : undefined}
            >
              <div className="zf-node-head">
                {node.name}
                <RuntimeStatePill state={node.state} dot />
              </div>
              <div className="zf-node-body">
                {node.lines.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
