import Link from "next/link";
import { LiveRefresh } from "@/components/live/live-refresh";
import { ProgramEditor } from "@/components/plc/program-editor";
import { StoredPlcShell } from "@/components/plc/stored-plc-shell";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { Button } from "@/components/ui/button";
import { type OperationButton, OperationForm } from "@/components/ui/operation-form";
import { SectionRule } from "@/components/ui/primitives";
import { RuntimeStatePill, StatePill, type Tone } from "@/components/ui/state-pill";
import type { PlcConfigurationView } from "@/lib/domain/plc-config-view";
import type { ProgramVersionStatus, ProgramVersionView } from "@/lib/domain/plc-runtime-view";
import { formatUtc } from "@/lib/factories/format";
import { routes } from "@/lib/navigation/routes";
import {
  getPlcProgramView,
  getPlcRuntimeView,
  getPlcVersionsView,
  readLivePlcState,
} from "@/lib/services/plc-runtime-view-service";
import { getRuntimeDeps } from "@/lib/services/runtime-deps";
import { programAction, programVersionAction, runtimeAction } from "../runtime-actions";
import { buildPlcContext } from "@/lib/agent/contexts/plc";
import { loadPlc } from "./load-plc";

/**
 * Program, Versions and Runtime of a PLC stored in the database. The runtime is known
 * here by the PLC's Z-Factory id and its service name; no Docker identifier is rendered.
 */

type Ids = { factoryId: string; plcId: string };

const VERSION_TONE: Record<ProgramVersionStatus, Tone> = {
  DRAFT: "neutral",
  COMPILED: "off",
  DEPLOYED: "run",
  FAILED: "flt",
  ARCHIVED: "off",
};

const SEVERITY_LEVEL = { INFO: "info", WARNING: "warn", CRITICAL: "crit" } as const;

/** `2026-10-05 04:21:56` from an ISO timestamp (UTC). */
const utcSeconds = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;

function Header({ view, title, kicker }: { view: PlcConfigurationView; title: string; kicker: string }) {
  return (
    <div className="flex items-end justify-between">
      <div>
        <div className="zf-k">{`${view.plc.name} · ${kicker}`}</div>
        <h1 className="zf-h mt-1.5">{title}</h1>
      </div>
      <StatePill tone="deg">simulated via OpenPLC</StatePill>
    </div>
  );
}

function VersionStatus({ version }: { version: ProgramVersionView }) {
  return <StatePill tone={VERSION_TONE[version.status]}>{version.status.toLowerCase()}</StatePill>;
}

/** 2i — Program: the Structured Text editor with check, save and deploy. */
export async function StoredPlcProgram({ factoryId, plcId, version }: Ids & { version?: number }) {
  const { actor, db, factory, view } = await loadPlc(factoryId, plcId);
  const program = await getPlcProgramView(db, actor, plcId, { version });
  const runtime = await getPlcRuntimeView(db, actor, plcId);

  return (
    <StoredPlcShell
      factory={factory}
      view={view}
      section="program"
      llmContext={buildPlcContext({ factory, view, section: "program", program, runtime })}
    >
      <Header view={view} title="Program" kicker="edit › save version › compile › deploy › run" />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_18.75rem] gap-3">
        <ProgramEditor
          // Opening another stored version starts the editor again with that text. Saving does not.
          key={version ?? "current"}
          action={programAction.bind(null, factoryId, plcId)}
          source={program.source}
          sourceVersion={program.sourceVersion}
          runtimeCreated={runtime.created}
          maxSourceBytes={program.maxSourceBytes}
        />
        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          <div className="zf-cell">
            <span className="zf-k">Runtime</span>
            <RuntimeStatePill state={runtime.state} />
            <span className="mono text-fg-dim">
              {runtime.deployedProgram ? `v${runtime.deployedProgram.version} deployed` : "no program deployed"}
            </span>
            <Button size="sm" variant="ghost" href={routes.plcRuntime(factoryId, plcId)} className="w-max">
              Open runtime
            </Button>
          </div>
          <div className="zf-cell">
            <span className="zf-k">{`Versions · ${program.versions.length}`}</span>
            {program.versions.slice(0, 5).map((item) => (
              <span key={item.id} className="mono flex items-center justify-between gap-2">
                <Link href={routes.plcProgram(factoryId, plcId, item.version)}>{`v${item.version}`}</Link>
                <span className="text-fg-dim">{`${item.status.toLowerCase()}${item.selected ? " · selected" : ""}`}</span>
              </span>
            ))}
            {program.versions.length === 0 ? <span className="zf-sub">No version saved yet.</span> : null}
            <Button size="sm" variant="ghost" href={routes.plcVersions(factoryId, plcId)} className="w-max">
              All versions
            </Button>
          </div>
          <div className="zf-cell">
            <span className="zf-k">{`Located variables · ${program.locatedVariables.length}`}</span>
            {program.locatedVariables.length === 0 ? (
              <span className="zf-sub">No tags yet. Connect devices to get tags for their signals.</span>
            ) : null}
            {program.locatedVariables.map((variable) => (
              <span
                key={variable.name}
                className="mono flex justify-between gap-2"
                title={variable.source ?? undefined}
              >
                <span className="syn-var truncate">{variable.name}</span>
                <span className="text-fg-dim">{`${variable.address} · ${variable.type}`}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </StoredPlcShell>
  );
}

/** Versions: program versions and the configuration recorded at each deployment. */
export async function StoredPlcVersions({ factoryId, plcId }: Ids) {
  const { actor, db, factory, view } = await loadPlc(factoryId, plcId);
  const versions = await getPlcVersionsView(db, actor, plcId);

  const versionButtons = (version: ProgramVersionView): OperationButton[] => [
    {
      operation: "select",
      label: "Use for next start",
      pendingLabel: "Selecting…",
      variant: "ghost",
      disabled: version.selected,
      title: version.selected ? "Already selected." : undefined,
    },
    {
      operation: "deploy",
      label: "Deploy now",
      pendingLabel: "Deploying…",
      disabled: !versions.runtimeCreated,
      title: versions.runtimeCreated ? undefined : "Start the runtime first (Runtime section).",
    },
  ];

  return (
    <StoredPlcShell
      factory={factory}
      view={view}
      section="versions"
      llmContext={buildPlcContext({ factory, view, section: "versions", versions })}
    >
      <Header view={view} title="Versions" kicker="program versions · deployment snapshots" />
      <SectionRule>
        <span className="zf-k">{`Program versions · ${versions.versions.length}`}</span>
      </SectionRule>
      {versions.versions.length > 0 ? (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Saved</th>
              <th>Checksum (SHA-256)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.versions.map((version) => (
              <tr key={version.id}>
                <td className="mono">
                  <Link href={routes.plcProgram(factoryId, plcId, version.version)}>{`v${version.version}`}</Link>
                  {version.selected ? <span className="text-fg-dim"> · selected</span> : null}
                </td>
                <td>
                  <VersionStatus version={version} />
                </td>
                <td className="mono">{formatUtc(version.createdAt)}</td>
                <td className="mono">{version.checksum.slice(0, 16)}</td>
                <td>
                  <OperationForm
                    label={`Version ${version.version}`}
                    size="sm"
                    action={programVersionAction.bind(null, factoryId, plcId, version.id)}
                    buttons={versionButtons(version)}
                    pendingHint="The runtime builds the program before it runs it. This can take a minute."
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="zf-sub">No program version yet. Write one in the Program section.</p>
      )}
      <p className="zf-sub">
        A version is immutable. &quot;Selected&quot; is the version the next start or deploy uses; &quot;deployed&quot;
        is the one last loaded into the runtime. A failed version did not compile or could not be built.
      </p>
      <SectionRule>
        <span className="zf-k">{`Deployment snapshots · ${versions.deployments.length}`}</span>
      </SectionRule>
      {versions.deployments.length > 0 ? (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Snapshot</th>
              <th>Deployed</th>
              <th>Program</th>
              <th>Compiler</th>
              <th>I/O · Modbus map</th>
              <th>Tags</th>
              <th>Runtime</th>
            </tr>
          </thead>
          <tbody>
            {versions.deployments.map((deployment, index) => (
              <tr key={deployment.version}>
                <td className="mono">
                  {`#${deployment.version}`}
                  {index === 0 ? <span className="text-fg-dim"> · latest</span> : null}
                </td>
                <td className="mono">{formatUtc(deployment.createdAt)}</td>
                <td className="mono">
                  {deployment.programVersion === null
                    ? "—"
                    : `v${deployment.programVersion} · ${deployment.programChecksum?.slice(0, 8) ?? ""}`}
                </td>
                <td className="mono">{deployment.compiler ?? "—"}</td>
                <td className="mono">{`v${deployment.ioMappingVersion ?? "—"} · v${deployment.modbusMappingVersion ?? "—"}`}</td>
                <td className="mono">{deployment.tagCount ?? "—"}</td>
                <td className="mono">{deployment.runtime ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="zf-sub">Nothing has been deployed yet. Each deployment records the configuration it ran with.</p>
      )}
    </StoredPlcShell>
  );
}

/** Runtime: lifecycle of the PLC's OpenPLC runtime, its state and what went wrong. */
export async function StoredPlcRuntime({ factoryId, plcId }: Ids) {
  // Read the live state first, so the shell shows what the runtime reports now.
  const first = await loadPlc(factoryId, plcId);
  const { liveError } = await readLivePlcState(first.db, getRuntimeDeps, first.actor, plcId);
  const { actor, db, factory, view } = await loadPlc(factoryId, plcId);
  const runtime = await getPlcRuntimeView(db, actor, plcId, { liveError });

  const active = runtime.created && runtime.state !== "STOPPED";
  const noRuntime = "Start the runtime first.";
  const buttons: OperationButton[] = [
    {
      operation: "start",
      label: runtime.created ? "Start" : "Start runtime",
      pendingLabel: "Starting…",
      variant: "primary",
      disabled: active,
      title: active ? "The runtime is already started." : undefined,
    },
    {
      operation: "deploy",
      label: runtime.selectedProgram ? `Deploy v${runtime.selectedProgram.version}` : "Deploy",
      pendingLabel: "Deploying…",
      disabled: !active || !runtime.selectedProgram,
      title: !runtime.selectedProgram ? "Save a program version first." : active ? undefined : noRuntime,
    },
    {
      operation: "restart",
      label: "Restart",
      pendingLabel: "Restarting…",
      variant: "ghost",
      disabled: !runtime.created,
      title: runtime.created ? undefined : noRuntime,
    },
    {
      operation: "stop",
      label: "Stop",
      pendingLabel: "Stopping…",
      variant: "ghost",
      disabled: !active,
      title: active ? undefined : "The runtime is not running.",
    },
    {
      operation: "remove",
      label: "Remove runtime",
      pendingLabel: "Removing…",
      variant: "danger",
      disabled: !runtime.created,
      title: runtime.created ? undefined : "There is no runtime to remove.",
      confirm: `Remove the runtime of ${view.plc.name}? Program versions, tags and the Modbus endpoint are kept.`,
    },
    {
      operation: "refresh",
      label: "Refresh state",
      pendingLabel: "Reading…",
      variant: "ghost",
    },
  ];

  return (
    <StoredPlcShell
      factory={factory}
      view={view}
      section="runtime"
      llmContext={buildPlcContext({ factory, view, section: "runtime", runtime })}
    >
      {/* Events of the factory refresh the page at once; the slower poll notices a container that died. */}
      <LiveRefresh streamUrl={routes.stream(factoryId)} />
      {runtime.created ? <AutoRefresh intervalMs={15000} /> : null}
      <Header view={view} title="Runtime" kicker="start › deploy › run › stop › remove" />
      <div className="grid grid-cols-4 gap-2.5">
        <div className="zf-cell">
          <span className="zf-k">State</span>
          <RuntimeStatePill state={runtime.state} />
          <span className="mono text-fg-dim">{runtime.created ? "runtime created" : "no runtime yet"}</span>
          {runtime.liveError ? (
            <span className="zf-error whitespace-normal" role="alert">
              {`${runtime.liveError} Showing the last stored state.`}
            </span>
          ) : null}
        </div>
        <div className="zf-cell">
          <span className="zf-k">Program</span>
          <span className="mono">
            {runtime.selectedProgram
              ? `v${runtime.selectedProgram.version} selected · ${runtime.selectedProgram.status.toLowerCase()}`
              : "no program version"}
          </span>
          <span className="mono text-fg-dim">
            {runtime.deployedProgram ? `v${runtime.deployedProgram.version} deployed` : "nothing deployed"}
          </span>
          <Button size="sm" variant="ghost" href={routes.plcProgram(factoryId, plcId)} className="w-max">
            Open program
          </Button>
        </div>
        <div className="zf-cell">
          <span className="zf-k">Modbus TCP endpoint</span>
          <span className="mono">
            {runtime.modbus ? `${runtime.modbus.bindAddress}:${runtime.modbus.hostPort}` : "assigned at first start"}
          </span>
          <span className="mono text-fg-dim">
            {runtime.serviceName ? `${runtime.serviceName}:502 in the factory network` : "no service name yet"}
          </span>
        </div>
        <div className="zf-cell">
          <span className="zf-k">Runtime</span>
          <span className="mono">{runtime.runtimeVersion ?? "OpenPLC Runtime"}</span>
          <span className="mono text-fg-dim break-all whitespace-normal">
            {runtime.image ?? "image not pulled yet"}
          </span>
        </div>
      </div>
      <OperationForm
        label="Runtime operations"
        action={runtimeAction.bind(null, factoryId, plcId)}
        buttons={buttons}
        pendingHint="The first start downloads the runtime image, and every deploy builds the program inside the runtime. This can take a few minutes; the result appears here when it is done."
      />
      <p className="zf-sub">
        The PLC runs on OpenPLC in a container of its own, inside the factory&apos;s network. It is a hardware profile
        on a generic runtime, not vendor firmware. Stopping keeps the container; removing it keeps the program versions.
      </p>
      <SectionRule>
        <span className="zf-k">{`Recent runtime events · ${runtime.events.length}`}</span>
      </SectionRule>
      {runtime.events.length > 0 ? (
        <div className="zf-log" role="log" aria-label="Recent runtime events">
          {runtime.events.map((event) => (
            <span key={event.id} className="zf-log-row">
              <span className="zf-log-ts">{utcSeconds(event.occurredAt)}</span>
              <span className="zf-log-lv" data-level={SEVERITY_LEVEL[event.severity]}>
                {event.severity.toLowerCase()}
              </span>
              <span className="whitespace-normal">
                {event.type}
                {event.detail ? <span className="text-fg-dim">{` · ${event.detail}`}</span> : null}
              </span>
            </span>
          ))}
        </div>
      ) : (
        <p className="zf-sub">No runtime events yet.</p>
      )}
    </StoredPlcShell>
  );
}
