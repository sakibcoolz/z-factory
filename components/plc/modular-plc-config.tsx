import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { Field, Gauge, KeyValue, PinRow, SectionRule, StepList } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { modularConfig } from "@/lib/fixtures/catalog";

/** 2g — modular PLC branch: CPU › rack › slots › compatible modules › channels. */
export function ModularPlcConfig() {
  const config = modularConfig;
  const selected = config.selectedModule;

  return (
    <AppShell
      title={`${config.factoryName} — Z-FACTORY`}
      activity="designer"
      sidebar={
        <SideBar title="New device">
          <StepList steps={config.steps} />
          <SideSection title="Rack budget">
            <KeyValue
              rows={config.budget.rows.map(
                ([label, value]) =>
                  [
                    label,
                    <span key="v" className="mono">
                      {value}
                    </span>,
                  ] as const,
              )}
            />
            <div className="px-4 pb-2.5 pt-2">
              <Gauge percent={config.budget.percent} label="Backplane power budget" />
            </div>
          </SideSection>
        </SideBar>
      }
      status={{ left: ["⊗ 0", "⚠ 0"], right: ["modular · 1511-1 PN"] }}
    >
      <EditorTabs tabs={[{ label: "Designer" }, { label: `● New device · ${config.instanceName}`, active: true }]} />
      <Content plain>
        <div className="flex items-end justify-between">
          <div>
            <div className="zf-k">Siemens · S7-1500 · modular</div>
            <h1 className="zf-h mt-1.5">Rack 0 · backplane</h1>
          </div>
          <span className="zf-k">drag module → slot · incompatible slots dim</span>
        </div>
        <div className="zf-rack">
          {config.slots.map((slot) =>
            slot.kind === "module" ? (
              <div
                key={slot.slot}
                className={
                  slot.emphasis === "cpu"
                    ? "zf-cell border-fg"
                    : slot.emphasis === "psu"
                      ? "zf-cell border-fg-dim"
                      : "zf-cell"
                }
                data-selected={slot.selected ?? false}
              >
                <span className="zf-k">{`Slot ${slot.slot}`}</span>
                <b className="text-fg-strong">{slot.name}</b>
                <span className="mono text-fg-dim">{slot.sku}</span>
                {slot.port ? <StatePill tone="run">{slot.port}</StatePill> : null}
              </div>
            ) : (
              <div key={slot.label} className="zf-box" data-tone={slot.target ? "target" : undefined}>
                {slot.label}
              </div>
            ),
          )}
        </div>
        <div className="grid grid-cols-[1fr_18.75rem] gap-3">
          <div className="flex flex-col gap-2">
            <SectionRule>
              <span className="zf-k">{`Compatible modules for slot ${config.targetSlot}`}</span>
            </SectionRule>
            <table className="zf-tbl">
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Order no.</th>
                  <th>Channels</th>
                  <th>Power</th>
                  <th>Check</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {config.moduleOptions.map((option) => (
                  <tr key={option.sku} data-muted={!option.compatible}>
                    <td>{option.name}</td>
                    <td className="mono">{option.sku}</td>
                    <td className="mono">{option.channels}</td>
                    <td className="mono">{option.power}</td>
                    <td>
                      <StatePill tone={option.check.tone}>{option.check.label}</StatePill>
                    </td>
                    <td>{option.compatible ? <Button size="sm">Add</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="zf-cell gap-2 self-start" data-selected="true">
            <span className="zf-k">{selected.title}</span>
            <PinRow pins={selected.pins} />
            {selected.fields.map((field) => (
              <Field key={field.label} label={field.label} value={field.value} mono={field.mono} size="sm" />
            ))}
          </div>
        </div>
        <div className="mt-auto flex gap-2 border-t border-line pt-2.5">
          <Button variant="ghost">Back</Button>
          <Button variant="primary">Next: channels &amp; terminals</Button>
          <Button variant="ghost" className="ml-auto">
            Save draft
          </Button>
        </div>
      </Content>
    </AppShell>
  );
}
