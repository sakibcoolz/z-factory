import type { Metadata } from "next";
import { FactoryForm } from "@/components/factories/factory-form";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { OperationForm } from "@/components/ui/operation-form";
import { SectionRule } from "@/components/ui/primitives";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { routes } from "@/lib/navigation/routes";
import { suggestFactorySubnet } from "@/lib/services/factory-service";
import { createDemoFactoryAction, createFactoryAction } from "../actions";

export const metadata: Metadata = { title: "New factory" };

export const dynamic = "force-dynamic";

/** 2c — Create Factory: identity and Docker network. */
export default async function NewFactoryPage() {
  await requireActor();
  const suggestedSubnet = (await suggestFactorySubnet(getDb())) ?? "";

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
        <FactoryForm
          mode="create"
          action={createFactoryAction}
          initial={{ name: "", slug: "", description: "", subnetCidr: suggestedSubnet }}
          cancelHref={routes.factories()}
        />
        <SectionRule>
          <span className="zf-k">Or start from the demo</span>
        </SectionRule>
        <p className="zf-sub">
          The pump station of the MVP demo: a pressure transmitter, a PLC with its program, a drive, a motor and a pump
          in a closed loop, and a gateway an edge device can connect to. It is built from catalog models like any
          factory and can be changed or deleted afterwards. Nothing is started until you start the factory.
        </p>
        <OperationForm
          label="Demo factory"
          action={createDemoFactoryAction}
          buttons={[{ operation: "create", label: "Create pump station demo", pendingLabel: "Building…" }]}
        />
      </Content>
    </AppShell>
  );
}
