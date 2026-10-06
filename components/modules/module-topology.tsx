import type { ModulePlcNode } from "@/lib/domain/module-designer-view";
import type { ModuleIoRegistry } from "@/lib/domain/module-io-view";
import type { ModuleRoleView } from "@/lib/domain/process-module-view";

type ModuleTopologyProps = {
  name: string;
  plcs: ModulePlcNode[];
  roles: ModuleRoleView[];
  registry: ModuleIoRegistry;
};

const ROW = 44;
const WIDTH = 720;
const COLUMN = { plc: 20, module: 290, device: 530 } as const;
const BOX = { w: 170, h: 34 } as const;
/** Characters that fit a box line at this font; longer labels are cut, the full text stays in the title. */
const FIT = 22;
const fit = (text: string) => (text.length > FIT ? `${text.slice(0, FIT - 1)}…` : text);

function Node({
  x,
  y,
  title,
  detail,
  tone = "normal",
}: {
  x: number;
  y: number;
  title: string;
  detail: string;
  tone?: "normal" | "module" | "missing";
}) {
  const stroke =
    tone === "module" ? "var(--color-focus)" : tone === "missing" ? "var(--color-fault-fg)" : "var(--color-line)";
  const fill = tone === "module" ? "var(--color-chrome)" : tone === "missing" ? "none" : "var(--color-side)";
  const text = tone === "missing" ? "var(--color-fault-fg)" : "var(--color-fg-strong)";
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={BOX.w}
        height={BOX.h}
        fill={fill}
        stroke={stroke}
        strokeDasharray={tone === "missing" ? "3 3" : undefined}
      />
      <title>{`${title} · ${detail}`}</title>
      <text x={x + 8} y={y + 14} fill={text}>
        {fit(title)}
      </text>
      <text x={x + 8} y={y + 27} fill={tone === "missing" ? text : "var(--color-fg-dim)"}>
        {fit(detail)}
      </text>
    </g>
  );
}

/**
 * The module between its PLCs and the devices in its roles, drawn from stored data only:
 * a PLC node says how many signals are bound to it, a device node which role it fills, a
 * required role without a device is drawn empty. A picture of the registry and the
 * assignments, not a second model.
 */
export function ModuleTopology({ name, plcs, roles, registry }: ModuleTopologyProps) {
  const devices = roles.flatMap((role) => role.devices.map((device) => ({ ...device, role: role.name })));
  const emptyRoles = roles.filter((role) => role.required && role.devices.length === 0);
  const rows = Math.max(plcs.length, devices.length + emptyRoles.length, 1);
  const height = rows * ROW + 20;
  const middle = height / 2;
  const y = (index: number) => 10 + index * ROW;
  const bound = registry.rows.filter((row) => row.state === "BOUND").length;
  const into = registry.rows.filter((row) => row.state === "BOUND" && row.signal.direction === "OUTPUT").length;
  const line = "var(--color-line-strong)";

  return (
    <figure className="zf-cell" aria-label={`Topology of ${name}`}>
      <svg viewBox={`0 0 ${WIDTH} ${height}`} width="100%" role="img" className="mono" fontSize={11}>
        <title>{`${name}: ${plcs.length} PLC${plcs.length === 1 ? "" : "s"}, ${devices.length} device${devices.length === 1 ? "" : "s"}, ${bound} signals bound`}</title>
        {plcs.map((plc, index) => (
          <g key={plc.plcId}>
            <line
              x1={COLUMN.plc + BOX.w}
              y1={y(index) + BOX.h / 2}
              x2={COLUMN.module}
              y2={middle}
              stroke={line}
              strokeWidth={plc.signals > 0 ? 1.5 : 1}
              strokeDasharray={plc.signals > 0 ? undefined : "3 3"}
            />
            <Node
              x={COLUMN.plc}
              y={y(index)}
              title={`PLC ${plc.name}`}
              detail={
                plc.signals > 0 ? `${plc.signals} signal${plc.signals === 1 ? "" : "s"} bound` : "no signal bound"
              }
            />
          </g>
        ))}
        {devices.map((device, index) => (
          <g key={device.assignmentId}>
            <line x1={COLUMN.module + BOX.w} y1={middle} x2={COLUMN.device} y2={y(index) + BOX.h / 2} stroke={line} />
            <Node x={COLUMN.device} y={y(index)} title={device.name} detail={device.role.toLowerCase()} />
          </g>
        ))}
        {emptyRoles.map((role, index) => (
          <g key={role.key}>
            <line
              x1={COLUMN.module + BOX.w}
              y1={middle}
              x2={COLUMN.device}
              y2={y(devices.length + index) + BOX.h / 2}
              stroke="var(--color-fault-fg)"
              strokeDasharray="3 3"
            />
            <Node
              x={COLUMN.device}
              y={y(devices.length + index)}
              title="no device"
              detail={role.name.toLowerCase()}
              tone="missing"
            />
          </g>
        ))}
        <Node
          x={COLUMN.module}
          y={middle - BOX.h / 2}
          title={name}
          detail={`${into} in · ${bound - into} out`}
          tone="module"
        />
      </svg>
    </figure>
  );
}
