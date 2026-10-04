import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { Field, Gauge, KeyValue, PinKey, PinRow, StepList } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { demoContext } from "@/lib/fixtures";
import { compactConfig } from "@/lib/fixtures/catalog";
import { factory } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";

type CompactPlcConfigProps = {
  factoryId: string;
};

/** 2f — compact PLC branch: built-in I/O and pin/channel view. */
export function CompactPlcConfig({ factoryId }: CompactPlcConfigProps) {
  const config = compactConfig;
  const channel = config.selectedChannel;
  const hasErrors = config.validationErrors > 0;

  return (
    <AppShell
      title={`${factory.name} — Z-FACTORY`}
      activity="designer"
      context={demoContext}
      sidebar={
        <SideBar title="New device">
          <StepList steps={config.steps} />
          <SideSection title="Instance">
            <KeyValue
              rows={[
                [
                  "Name",
                  <span key="v" className="mono text-fg-strong">
                    {config.instanceName}
                  </span>,
                ],
                ["Role", config.role],
                [
                  "Runtime",
                  <span key="v" className="syn-type">
                    OpenPLC
                  </span>,
                ],
              ]}
            />
          </SideSection>
        </SideBar>
      }
      status={{
        tone: hasErrors ? "flt" : "ok",
        left: [`⊗ ${config.validationErrors} error`, "⚠ 0 warnings"],
        right: ["compact · 1214C"],
      }}
    >
      <EditorTabs
        tabs={[
          { label: "Designer", href: routes.designer(factoryId) },
          { label: `● New device · ${config.instanceName}`, active: true },
        ]}
      />
      <Content plain>
        <div className="flex items-end justify-between">
          <div>
            <div className="zf-k">Siemens · S7-1200 · compact</div>
            <h1 className="zf-h mt-1.5">Built-in I/O &amp; pin view</h1>
          </div>
          <StatePill tone="deg">simulated via OpenPLC</StatePill>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <div className="zf-cell">
            <span className="zf-k">Power</span>
            <span className="mono">{config.power}</span>
          </div>
          <div className="zf-cell">
            <span className="zf-k">{config.commPort.label}</span>
            <div className="zf-in mono" data-size="sm">
              {config.commPort.address}
            </div>
          </div>
          <div className="zf-cell">
            <span className="zf-k">Occupancy</span>
            <span className="mono">{config.occupancy.label}</span>
            <Gauge percent={config.occupancy.percent} label="Channel occupancy" />
          </div>
        </div>
        <div className="grid grid-cols-[1fr_18.75rem] gap-3">
          <div className="zf-cell gap-2.5">
            {config.banks.map((bank) => (
              <div key={bank.label} className="flex flex-col gap-2.5">
                <div className="flex justify-between">
                  <span className="mono">{bank.label}</span>
                  <span className="zf-k">{bank.kind}</span>
                </div>
                <PinRow pins={bank.pins} />
              </div>
            ))}
            <div className="zf-k flex gap-2.5">
              <PinKey state="occupied">occupied</PinKey>
              <PinKey state="selected">selected</PinKey>
              <PinKey state="free">free</PinKey>
            </div>
          </div>
          <div className="zf-cell gap-2" data-selected="true">
            <span className="zf-k">{channel.title}</span>
            <Field label="Connected device" value={channel.device} size="sm" />
            <Field label="Signal" value={channel.signal} mono size="sm" state="invalid" />
            <p className="text-xs leading-normal text-fault-fg" role="alert">
              ✕ {channel.signalError}
            </p>
            <Field label="Logical address" value={channel.logicalAddress} mono size="sm" />
            <Field label="Tag" value={channel.tag} mono size="sm" state="focus" />
          </div>
        </div>
        <div className="mt-auto flex items-center gap-2 border-t border-line pt-2.5">
          <Button variant="ghost" href={routes.designer(factoryId)}>
            Back
          </Button>
          <Button variant="primary" disabled={hasErrors}>
            Next: tags &amp; protocol
          </Button>
          {hasErrors ? (
            <span className="zf-k text-fault-fg">{`${config.validationErrors} validation error`}</span>
          ) : null}
          <Button variant="ghost" className="ml-auto">
            Save draft
          </Button>
        </div>
      </Content>
    </AppShell>
  );
}
