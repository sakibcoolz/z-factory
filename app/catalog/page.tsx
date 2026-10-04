import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { SectionRule } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { catalogModel, catalogTree, catalogTypeFilters } from "@/lib/fixtures/catalog";

export const metadata: Metadata = { title: "Device catalog" };

/** 2e — Device Catalog: manufacturer › family › model, verified sources. */
export default function CatalogPage() {
  const model = catalogModel;

  return (
    <AppShell
      title="Device Catalog — Z-FACTORY"
      command="search model or order no."
      activity="catalog"
      sidebar={
        <SideBar title="Catalog">
          <SideSection title="Manufacturer">
            <Tree items={catalogTree} />
          </SideSection>
          <SideSection title="Type">
            <div className="zf-chips">
              {catalogTypeFilters.map((filter) => (
                <StatePill key={filter.label} tone={filter.active ? "start" : "off"}>
                  {filter.label}
                </StatePill>
              ))}
            </div>
          </SideSection>
        </SideBar>
      }
      status={{
        left: ["catalog", `${model.totals.models} models · ${model.totals.manufacturers} manufacturers`],
        right: ["source policy ok"],
      }}
    >
      <EditorTabs
        tabs={[{ label: model.name, active: true }, { label: "CPU 1511-1 PN" }]}
        crumb="catalog › siemens › s7-1200"
      />
      <Content plain>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="zf-k">{`${model.manufacturer} · ${model.family} · ${model.architecture}`}</div>
            <h1 className="zf-h mt-1.5">{model.name}</h1>
            <div className="mono mt-1 text-fg-dim">{model.sku}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <StatePill tone="run">{`verified ${model.verifiedAt}`}</StatePill>
            <Button size="sm" variant="primary">
              Use in factory
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-[1.1fr_1fr_1fr] gap-3">
          <div className="zf-box h-37.5">
            product photo / outline drawing
            <br />
            (grayscale)
          </div>
          {model.facts.map((group, groupIndex) => (
            <div key={groupIndex} className="zf-cell">
              {group.map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <span className="zf-k">{label}</span>
                  <span className="mono">{value}</span>
                </div>
              ))}
              {groupIndex === model.facts.length - 1 ? (
                <div className="flex flex-col gap-1.5">
                  <span className="zf-k">Runtime mapping</span>
                  <span className="mono syn-type">{model.runtimeMapping}</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <SectionRule>
          <span className="zf-k">Compatible peripherals (shown in device creation)</span>
        </SectionRule>
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Type</th>
              <th>Model</th>
              <th>Signal / protocol</th>
              <th>Channel class</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {model.compatiblePeripherals.map((peripheral) => (
              <tr key={peripheral.model}>
                <td>{peripheral.type}</td>
                <td className="mono">{peripheral.model}</td>
                <td className="mono">{peripheral.signal}</td>
                <td className="mono">{peripheral.channelClass}</td>
                <td className="mono syn-comment">simulated</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="zf-sub mt-auto">
          Normalized metadata from manufacturer sources (docs/references/plc-source-policy.md). No vendor firmware
          emulation.
        </p>
      </Content>
    </AppShell>
  );
}
