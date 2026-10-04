import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { Button } from "@/components/ui/button";
import { Field, SectionRule } from "@/components/ui/primitives";
import { DEMO_FACTORY_ID, factoryTemplates } from "@/lib/fixtures/factories";
import { routes } from "@/lib/navigation/routes";

export const metadata: Metadata = { title: "New factory" };

/** 2c — Create Factory: identity, Docker network, template. */
export default function NewFactoryPage() {
  return (
    <AppShell title="Z-FACTORY" activity="factories" status={{ tone: "off", left: ["draft"] }}>
      <EditorTabs
        tabs={[
          { label: "Factories", href: routes.factories() },
          { label: "● New factory", active: true },
        ]}
      />
      <Content plain className="gap-4">
        <div>
          <div className="zf-k">Factories › new</div>
          <h1 className="zf-h mt-1.5">Create factory</h1>
        </div>
        <div className="grid max-w-180 grid-cols-2 gap-x-5 gap-y-3">
          <Field label="Name" value="Pump House Demo" state="focus" />
          <Field label="Slug" value="pump-house-demo" mono />
          <Field label="Description" value="optional" size="area" className="col-span-2" />
        </div>
        <SectionRule>
          <span className="zf-k">Docker network · isolated per factory</span>
        </SectionRule>
        <div className="grid max-w-180 grid-cols-3 gap-x-5 gap-y-3">
          <Field label="Network" value="zfactory_factory_001" mono />
          <Field label="Subnet" value="172.20.1.0/24" mono />
          <Field label="Published port range" value="15021–15029" mono />
        </div>
        <SectionRule>
          <span className="zf-k">Start from</span>
        </SectionRule>
        <div className="grid max-w-180 grid-cols-3 gap-2.5">
          {factoryTemplates.map((template) => (
            <div key={template.name} className="zf-cell" data-selected={template.selected}>
              <b className="text-fg-strong">{template.name}</b>
              <span className="text-xs text-fg-muted">{template.description}</span>
            </div>
          ))}
        </div>
        <div className="mt-auto flex gap-2 border-t border-line pt-3">
          <Button variant="primary" href={routes.designer(DEMO_FACTORY_ID)}>
            Create &amp; open designer
          </Button>
          <Button variant="ghost" href={routes.factories()}>
            Cancel
          </Button>
        </div>
      </Content>
    </AppShell>
  );
}
