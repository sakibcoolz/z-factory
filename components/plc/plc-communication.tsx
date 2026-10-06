import { type OperationButton, OperationForm } from "@/components/ui/operation-form";
import { SectionRule } from "@/components/ui/primitives";
import { StatePill, type Tone } from "@/components/ui/state-pill";
import { PLC_RELATIONSHIP_LABELS } from "@/lib/domain/plc-communication";
import type { CommunicationLinkView, PlcCommunicationView } from "@/lib/domain/plc-communication-view";
import type { OperationState } from "@/lib/plc/operation-state";
import { LinkSettings, MappingForm, NewLinkForm } from "./plc-communication-forms";

type Action = (state: OperationState, formData: FormData) => Promise<OperationState>;

/** The screen's server actions, bound by the page. */
export type CommunicationActions = {
  create: Action;
  link: (linkId: string) => Action;
  addMapping: (linkId: string) => Action;
  mapping: (linkId: string, mappingId: string) => Action;
  linkFile: (linkId: string) => string;
  peerHref: (plcId: string) => string;
};

const QUALITY_TONE: Record<string, Tone> = { GOOD: "run", STALE: "deg", DISCONNECTED: "disc" };

function LinkCard({ entry, actions }: { entry: CommunicationLinkView; actions: CommunicationActions }) {
  const { link, health } = entry;
  const client = link.client === "SOURCE" ? link.source : link.target;
  const server = link.client === "SOURCE" ? link.target : link.source;
  const current = entry.deployedVersion === link.configVersion;
  const buttons: OperationButton[] = [
    link.enabled
      ? { operation: "disable", label: "Disable", pendingLabel: "Disabling…" }
      : { operation: "enable", label: "Enable", pendingLabel: "Enabling…", variant: "primary" },
    {
      operation: "remove",
      label: "Remove link",
      pendingLabel: "Removing…",
      variant: "danger",
      confirm: "Remove this link and its values? Both PLCs stay as they are.",
    },
  ];
  return (
    <section className="zf-cell flex flex-col gap-2" aria-label={`Link to ${entry.peer.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <b className="mono text-fg-strong">{`${link.source.name} ${PLC_RELATIONSHIP_LABELS[link.relationship]} ${link.target.name}`}</b>
          <StatePill tone={entry.role === "client" ? "start" : "neutral"}>{`this PLC is the ${entry.role}`}</StatePill>
          {!link.enabled ? <StatePill tone="off">disabled</StatePill> : null}
          {health ? (
            <StatePill tone={QUALITY_TONE[health.quality] ?? "neutral"}>{health.quality.toLowerCase()}</StatePill>
          ) : null}
        </div>
        <OperationForm
          label={`Link to ${entry.peer.name}`}
          size="sm"
          action={actions.link(link.id)}
          buttons={buttons}
        />
      </div>
      <p className="mono text-fg-dim whitespace-normal">
        {`${client.name} (client) → Modbus TCP ${link.serverHost}:${link.serverPort} unit ${link.unitId} → ${server.name} (server) · every ${link.pollIntervalMs} ms · version ${link.configVersion}`}
      </p>
      <p className={current || !link.enabled ? "zf-sub" : "zf-error"}>
        {entry.deployedVersion === null
          ? `${client.name} has not been deployed with this link yet; deploy its program to start the exchange.`
          : current
            ? `${client.name}'s runtime runs this version of the link.`
            : `${client.name} runs version ${entry.deployedVersion}; deploy its program to apply version ${link.configVersion}.`}
        {health?.reason ? ` ${health.reason}` : ""}
        {!health ? " The link's health is shown while the factory runs." : ""}
      </p>
      <table className="zf-tbl" aria-label={`Values on the link to ${entry.peer.name}`}>
        <thead>
          <tr>
            <th>Direction</th>
            <th>{`${client.name} tag`}</th>
            <th>{`${server.name} tag · register`}</th>
            <th>Type</th>
            <th>Interval</th>
            <th>Quality</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entry.mappings.map((mapping) => (
            <tr key={mapping.id}>
              <td className="mono">
                {mapping.operation === "READ" ? `READ ← ${server.name}` : `WRITE → ${server.name} command`}
              </td>
              <td className="mono">{`${mapping.localTag.name} · ${mapping.localTag.logicalAddress ?? "—"}`}</td>
              <td className="mono">
                {`${mapping.remoteTag.name} · ${mapping.remoteTag.logicalAddress ?? "—"}`}
                <span className="zf-sub block">{`${mapping.remoteTag.area?.toLowerCase().replace("_", " ") ?? "—"} ${mapping.remoteTag.address ?? ""}`}</span>
              </td>
              <td className="mono">{`${mapping.remoteTag.dataType}${mapping.remoteTag.unit ? ` ${mapping.remoteTag.unit}` : ""}`}</td>
              <td className="mono">{`${mapping.effectiveIntervalMs} ms`}</td>
              <td>
                {!mapping.enabled ? (
                  <StatePill tone="off">paused</StatePill>
                ) : mapping.quality ? (
                  <StatePill tone={QUALITY_TONE[mapping.quality] ?? "neutral"}>
                    {mapping.quality.toLowerCase()}
                  </StatePill>
                ) : (
                  <span className="zf-sub">—</span>
                )}
              </td>
              <td>
                {entry.role === "client" ? (
                  <OperationForm
                    label={`Value ${mapping.localTag.name}`}
                    size="sm"
                    action={actions.mapping(link.id, mapping.id)}
                    buttons={[
                      mapping.enabled
                        ? { operation: "disable", label: "Pause", pendingLabel: "Saving…", variant: "ghost" }
                        : { operation: "enable", label: "Resume", pendingLabel: "Saving…", variant: "ghost" },
                      { operation: "remove", label: "Remove", pendingLabel: "Removing…", variant: "danger" },
                    ]}
                  />
                ) : null}
              </td>
            </tr>
          ))}
          {entry.mappings.length === 0 ? (
            <tr>
              <td colSpan={7} className="zf-sub">
                No value is carried yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="zf-sub">
        {`A WRITE reaches ${server.name}'s command and setpoint tags only; ${server.name}'s program decides what its outputs do.`}{" "}
        <a className="underline" href={actions.linkFile(link.id)}>
          Link and values (JSON)
        </a>
        {" · "}
        <a className="underline" href={actions.peerHref(entry.peer.plcId)}>
          {`${entry.peer.name}'s Communication screen`}
        </a>
      </p>
      {entry.role === "client" ? (
        <>
          <MappingForm entry={entry} action={actions.addMapping(link.id)} />
          <LinkSettings entry={entry} action={actions.link(link.id)} />
        </>
      ) : (
        <p className="zf-sub">{`The values of this link are configured on ${client.name}, its client.`}</p>
      )}
    </section>
  );
}

/** A PLC's links to other PLCs of its factory, the values they carry and how they are doing. */
export function PlcCommunication({
  view,
  plc,
  actions,
}: {
  view: PlcCommunicationView;
  plc: { name: string };
  actions: CommunicationActions;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="zf-sub max-w-180">
        {`${plc.name} keeps its own program, runtime and outputs. A link lets one PLC read another's values and write its command and setpoint tags; the PLC that is written still decides. The client PLC's own runtime does the exchange on the factory network.`}
      </p>
      {view.links.length === 0 ? <p className="zf-sub">No link yet.</p> : null}
      {view.links.map((entry) => (
        <LinkCard key={entry.link.id} entry={entry} actions={actions} />
      ))}
      <SectionRule>
        <span className="zf-k">New link</span>
      </SectionRule>
      <NewLinkForm view={view} action={actions.create} />
    </div>
  );
}
