import Link from "next/link";
import { type OperationButton, OperationForm } from "@/components/ui/operation-form";
import { SectionRule } from "@/components/ui/primitives";
import { StatePill, type Tone } from "@/components/ui/state-pill";
import type { ModuleDesignerView } from "@/lib/domain/module-designer-view";
import type { ModuleIoRow } from "@/lib/domain/module-io-view";
import type { ProcessQuality } from "@/lib/domain/process-bridge";
import type { OperationState } from "@/lib/plc/operation-state";
import { routes } from "@/lib/navigation/routes";
import { ImportIoForm, InterlockForm, ModuleSettingsForm, RoleAssignForm, SignalBindForm } from "./module-forms";
import { ReadinessPill } from "./module-list";
import { ModuleTopology } from "./module-topology";

type Action = (state: OperationState, formData: FormData) => Promise<OperationState>;

/** The server actions of the editor, bound to the module by the page. */
export type ModuleEditorActions = {
  update: Action;
  device: Action;
  signal: Action;
  interlock: Action;
  importIo: Action;
  bridge: Action;
};

/** The editor's sections, in the order of docs/design.md. */
export const MODULE_SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "roles", label: "Device roles" },
  { key: "registry", label: "Consumed PLC I/O" },
  { key: "interlocks", label: "Interlocks" },
  { key: "runtime", label: "Runtime" },
  { key: "topology", label: "Topology" },
  { key: "export", label: "Export" },
] as const;

const STATE_TONE: Record<ModuleIoRow["state"], Tone> = { BOUND: "run", INVALID: "flt", UNBOUND: "off" };
const QUALITY_TONE: Record<ProcessQuality, Tone> = { GOOD: "run", STALE: "deg", DISCONNECTED: "disc" };
const DIRECTION_LABEL = { INPUT: "input", OUTPUT: "output", ALARM: "alarm", INTERNAL: "internal" } as const;

function rowState(row: ModuleIoRow): string {
  if (row.state === "BOUND") return "bound";
  if (row.state === "INVALID") return "invalid";
  return row.blocking ? "required · unbound" : "optional · unbound";
}

function Heading({ id, label, meta }: { id: string; label: string; meta?: string }) {
  return (
    <SectionRule>
      <span id={id} className="zf-k">
        {meta ? `${label} · ${meta}` : label}
      </span>
    </SectionRule>
  );
}

/** One module's editor: every section of docs/design.md → Process module UX that has data today. */
export function ModuleEditor({ view, actions }: { view: ModuleDesignerView; actions: ModuleEditorActions }) {
  const { module, type, registry, runtime } = view;
  const counts = registry.counts;
  const total = (direction: keyof typeof counts) => counts[direction];
  const consumed = total("INPUT").total + total("OUTPUT").total + total("ALARM").total;
  const bound = total("INPUT").bound + total("OUTPUT").bound + total("ALARM").bound;

  const bridgeButtons: OperationButton[] = runtime.bridgeRunning
    ? [
        {
          operation: "stop",
          label: "Stop process bridge",
          pendingLabel: "Stopping…",
          confirm: "Stop the process bridge of the whole factory? Every module's model is unloaded.",
        },
      ]
    : [
        {
          operation: "start",
          label: "Start process bridge",
          pendingLabel: "Starting…",
          variant: "primary",
          disabled: !module.readyToRun || runtime.serviceNote !== null,
          title:
            runtime.serviceNote ??
            (module.readyToRun
              ? "Runs every ready module of the factory against its PLCs."
              : "Complete the module and bind its required signals first."),
        },
      ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="zf-k">{`Process module · ${type.name} v${type.version}`}</div>
          <h1 className="zf-h mt-1.5">{module.name}</h1>
          {type.description ? <p className="zf-sub mt-1 max-w-180">{type.description}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <ReadinessPill module={module} />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2.5">
        <div className="zf-cell">
          <span className="zf-k">Profile</span>
          <span className="mono text-fg-strong">{module.profile ?? "—"}</span>
          <span className="mono text-fg-dim">{`${type.profiles.length} profile${type.profiles.length === 1 ? "" : "s"} in the type`}</span>
        </div>
        <div className="zf-cell">
          <span className="zf-k">Devices in roles</span>
          <span className="mono text-fg-strong">{`${module.deviceCount} of ${module.roles.length} roles`}</span>
          <span className="mono text-fg-dim">
            {module.issues.length === 0
              ? "every required role filled"
              : `${module.issues.length} issue${module.issues.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="zf-cell">
          <span className="zf-k">Signals bound</span>
          <span className="mono text-fg-strong">{`${bound} of ${consumed}`}</span>
          <span className="mono text-fg-dim">
            {`${total("INPUT").requiredUnbound + total("OUTPUT").requiredUnbound + total("ALARM").requiredUnbound} required unbound · ${total("INPUT").invalid + total("OUTPUT").invalid + total("ALARM").invalid} invalid`}
          </span>
        </div>
        <div className="zf-cell">
          <span className="zf-k">Process model</span>
          <span className="mono text-fg-strong">{type.simulatorModelType ?? "none"}</span>
          <span className="mono text-fg-dim">
            {runtime.bridgeRunning
              ? `bridge running · ${runtime.status?.toLowerCase() ?? "not loaded"}`
              : "bridge stopped"}
          </span>
        </div>
      </div>

      <Heading id="overview" label="Settings" />
      <ModuleSettingsForm module={module} type={type} action={actions.update} />
      {module.issues.length > 0 ? (
        <ul className="zf-error list-disc pl-4" aria-label="Issues">
          {module.issues.map((issue) => (
            <li key={`${issue.rule}-${issue.subject}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}

      <Heading id="roles" label="Device roles" meta={`${module.roles.length}`} />
      <table className="zf-tbl">
        <thead>
          <tr>
            <th>Role</th>
            <th>Takes</th>
            <th>Devices</th>
            <th>Assign</th>
          </tr>
        </thead>
        <tbody>
          {module.roles.map((role) => (
            <tr key={role.key}>
              <td>
                <span className="mono">{role.key}</span>
                <span className="zf-sub block">{`${role.name}${role.required ? "" : " · optional"}`}</span>
              </td>
              <td className="mono whitespace-normal">{role.deviceCategoryCodes.join(", ") || "any category"}</td>
              <td>
                {role.devices.length === 0 ? (
                  <span className={role.required ? "zf-error" : "zf-sub"}>
                    {role.required ? "no device — required" : "no device"}
                  </span>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {role.devices.map((device) => (
                      <li key={device.assignmentId} className="flex flex-wrap items-center gap-1.5">
                        <Link className="mono" href={routes.device(module.factoryId, device.deviceId)}>
                          {device.name}
                        </Link>
                        <span className="zf-sub">{`${device.categoryName} · ${device.manufacturer} ${device.modelName}`}</span>
                        <OperationForm
                          label={`${device.name} as ${role.name}`}
                          size="sm"
                          action={actions.device}
                          fields={{ assignmentId: device.assignmentId }}
                          buttons={[
                            { operation: "unassign", label: "Unassign", pendingLabel: "Removing…", variant: "ghost" },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td>
                <RoleAssignForm
                  roleKey={role.key}
                  roleName={role.name}
                  devices={view.assignable[role.key] ?? []}
                  full={role.devices.length >= role.maxDevices}
                  action={actions.device}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="zf-sub">
        A role takes an existing device of this factory. The device keeps its model, wiring and tags; a device may serve
        several modules.
      </p>

      <Heading id="registry" label="Consumed PLC I/O" meta={`${bound} of ${consumed} bound`} />
      <div className="grid grid-cols-4 gap-2.5">
        {(["INPUT", "OUTPUT", "ALARM"] as const).map((direction) => (
          <div key={direction} className="zf-cell">
            <span className="zf-k">{`${DIRECTION_LABEL[direction]}s`}</span>
            <span className="mono text-fg-strong">{`${counts[direction].bound} of ${counts[direction].total} bound`}</span>
            <span className="mono text-fg-dim">{`${counts[direction].requiredUnbound} required unbound · ${counts[direction].invalid} invalid`}</span>
          </div>
        ))}
        <div className="zf-cell">
          <span className="zf-k">PLCs used</span>
          <span className="mono text-fg-strong">{registry.plcs.length}</span>
          <span className="mono text-fg-dim whitespace-normal">
            {registry.plcs.map((plc) => `${plc.plcName} ${plc.inputs}/${plc.outputs}/${plc.alarms}`).join(" · ") ||
              "none"}
          </span>
        </div>
      </div>
      <table className="zf-tbl" aria-label="Consumed PLC I/O registry">
        <thead>
          <tr>
            <th>Signal</th>
            <th>Direction</th>
            <th>Type</th>
            <th>State</th>
            <th>Bound to</th>
            <th>Tag</th>
          </tr>
        </thead>
        <tbody>
          {registry.rows.map((row) => (
            <tr key={row.signal.key} data-state={row.state}>
              <td>
                <span className="mono">{row.signal.key}</span>
                <span className="zf-sub block">{row.signal.name}</span>
              </td>
              <td className="mono">{`${DIRECTION_LABEL[row.signal.direction]} · ${row.signal.role.toLowerCase().replace("_", " ")}`}</td>
              <td className="mono">{`${row.signal.dataType}${row.signal.unit ? ` ${row.signal.unit}` : ""}`}</td>
              <td>
                <StatePill tone={row.blocking ? "flt" : STATE_TONE[row.state]}>{rowState(row)}</StatePill>
                {row.issue ? <span className="zf-error block whitespace-normal">{row.issue.message}</span> : null}
              </td>
              <td className="mono whitespace-normal">
                {row.binding ? (
                  <>
                    <Link href={routes.plc(module.factoryId, row.binding.plcId)}>{row.binding.plcName}</Link>
                    {` · ${row.binding.tagName} · ${row.binding.logicalAddress ?? "—"}`}
                    <span className="zf-sub block">{`${row.binding.dataType}${row.binding.unit ? ` ${row.binding.unit}` : ""} · scale ${row.binding.scale} · ${row.binding.modbusArea?.toLowerCase().replace("_", " ") ?? "—"} ${row.binding.modbusAddress ?? ""}`}</span>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td>
                <SignalBindForm row={row} candidates={view.candidates[row.signal.key] ?? []} action={actions.signal} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {registry.internal.length > 0 ? (
        <p className="zf-sub">{`Internal to the process model, not bound to a tag: ${registry.internal.map((signal) => signal.key).join(", ")}.`}</p>
      ) : null}
      <p className="zf-sub">
        A signal takes a tag the PLC program drives: a command from a %Q or %M address, feedback to a %M address. Tags a
        gateway may write, tags that carry a device signal, and tags of other modules are not possible; the picker says
        why.
      </p>

      <Heading id="interlocks" label="Interlocks" meta={`${module.interlocks.length}`} />
      {module.interlocks.length > 0 ? (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Code</th>
              <th>While</th>
              <th>Blocks</th>
              <th>Severity</th>
              <th>Enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {module.interlocks.map((interlock) => (
              <tr key={interlock.id}>
                <td>
                  <span className="mono">{interlock.code}</span>
                  <span className="zf-sub block">{interlock.name}</span>
                </td>
                <td className="mono whitespace-normal">
                  {interlock.expression.when
                    .map(
                      (condition) =>
                        `${condition.signal} ${condition.operator}${condition.value !== undefined ? ` ${condition.value}` : ""}`,
                    )
                    .join(" and ")}
                </td>
                <td className="mono whitespace-normal">{interlock.expression.blocks.join(", ")}</td>
                <td>{interlock.severity.toLowerCase()}</td>
                <td>{interlock.enabled ? "yes" : "no"}</td>
                <td>
                  <OperationForm
                    label={`Interlock ${interlock.code}`}
                    size="sm"
                    action={actions.interlock}
                    fields={{ interlockId: interlock.id }}
                    buttons={[
                      interlock.enabled
                        ? { operation: "disable", label: "Disable", pendingLabel: "Saving…" }
                        : { operation: "enable", label: "Enable", pendingLabel: "Saving…" },
                      {
                        operation: "remove",
                        label: "Remove",
                        pendingLabel: "Removing…",
                        variant: "danger",
                        confirm: "Remove this interlock?",
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="zf-sub">
          No interlock yet. An interlock documents and tests what the program must hold off; it never acts on the PLC
          and is never a safety function.
        </p>
      )}
      <InterlockForm signals={module.signals} action={actions.interlock} />

      <Heading id="runtime" label="Runtime" />
      {runtime.serviceNote ? <p className="zf-sub">{runtime.serviceNote}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <OperationForm
          label="Process bridge"
          size="sm"
          action={actions.bridge}
          buttons={bridgeButtons}
          pendingHint="The models are loaded into the simulation service and the PLCs are read."
        />
        {runtime.bridgeRunning && runtime.quality ? (
          <>
            <StatePill tone={QUALITY_TONE[runtime.quality]}>{runtime.quality.toLowerCase()}</StatePill>
            <span className="mono text-fg-dim">{`tick ${runtime.tick} · ${runtime.timeS.toFixed(1)} s simulated`}</span>
            {runtime.alarms.length > 0 ? (
              <StatePill tone="flt">{`alarms: ${runtime.alarms.join(", ")}`}</StatePill>
            ) : null}
            {runtime.error ? <span className="zf-error">{runtime.error}</span> : null}
          </>
        ) : runtime.bridgeRunning ? (
          <span className="zf-sub">
            The bridge runs, but not this module: it was not ready when the bridge started.
          </span>
        ) : null}
      </div>
      {runtime.bridgeRunning && runtime.quality ? (
        <table className="zf-tbl" aria-label="Live process values">
          <thead>
            <tr>
              <th>Signal</th>
              <th>Direction</th>
              <th>Value</th>
              <th>Bound to</th>
            </tr>
          </thead>
          <tbody>
            {registry.rows.map((row) => {
              const value =
                row.signal.direction === "OUTPUT" ? runtime.inputs[row.signal.key] : runtime.outputs[row.signal.key];
              return (
                <tr key={row.signal.key}>
                  <td className="mono">{row.signal.key}</td>
                  <td className="mono">{DIRECTION_LABEL[row.signal.direction]}</td>
                  <td className="mono">
                    {value === undefined
                      ? "—"
                      : row.signal.dataType === "BOOL"
                        ? value !== 0
                          ? "on"
                          : "off"
                        : `${value}${row.signal.unit ? ` ${row.signal.unit}` : ""}`}
                  </td>
                  <td className="mono">{row.binding ? `${row.binding.plcName} · ${row.binding.tagName}` : "—"}</td>
                </tr>
              );
            })}
            {registry.internal.map((signal) => (
              <tr key={signal.key}>
                <td className="mono">{signal.key}</td>
                <td className="mono">internal</td>
                <td className="mono">
                  {runtime.outputs[signal.key] === undefined
                    ? "—"
                    : `${runtime.outputs[signal.key]}${signal.unit ? ` ${signal.unit}` : ""}`}
                </td>
                <td className="mono">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="zf-sub">
        Live values come from bridge memory and are read on each refresh; the history is in{" "}
        <Link className="underline" href={routes.events(module.factoryId, { family: "PROCESS" })}>
          Events
        </Link>
        . The PLC program decides; the process model only answers.
      </p>

      <Heading id="topology" label="Topology" />
      <ModuleTopology name={module.name} plcs={view.plcs} roles={module.roles} registry={registry} />

      <Heading id="export" label="Export" />
      <p className="zf-sub">
        <a className="underline" href={routes.moduleIoFile(module.factoryId, module.id)}>
          Bindings by names (module-io.json)
        </a>
        {
          " — the signals of this module and the PLC and tag each is bound to; another module of the same type and profile rebuilds them from it. The PLC engineering export lists the module signals of each PLC."
        }
      </p>
      <ImportIoForm action={actions.importIo} />
    </div>
  );
}
