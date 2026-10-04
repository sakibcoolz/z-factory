import type { Metadata } from "next";
import { FactoryForm } from "@/components/factories/factory-form";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { routes } from "@/lib/navigation/routes";
import { suggestFactorySubnet } from "@/lib/services/factory-service";
import { createFactoryAction } from "../actions";

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
      </Content>
    </AppShell>
  );
}
