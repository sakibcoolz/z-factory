import type { Metadata } from "next";
import { FactoryExplorer } from "@/components/factories/factory-explorer";
import { FactoryForm } from "@/components/factories/factory-form";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { routes } from "@/lib/navigation/routes";
import { updateFactoryAction } from "../../actions";
import { loadFactory } from "../load-factory";

export const metadata: Metadata = { title: "Edit factory" };

export const dynamic = "force-dynamic";

type EditFactoryPageProps = {
  params: Promise<{ factoryId: string }>;
};

export default async function EditFactoryPage({ params }: EditFactoryPageProps) {
  const { factoryId } = await params;
  const { factory, factories } = await loadFactory(factoryId);

  return (
    <AppShell
      title={`${factory.name} — Z-FACTORY`}
      activity="factories"
      badges={{ factories: factories.length }}
      sidebar={<FactoryExplorer factories={factories} activeFactoryId={factory.id} />}
      status={{ tone: "off", left: [`⎇ ${factory.slug}`, "editing"] }}
    >
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: `● Edit · ${factory.name}`, active: true },
        ]}
        crumb={`factories › ${factory.slug} › edit`}
      />
      <Content plain className="gap-4">
        <div>
          <div className="zf-k">{`Factories › ${factory.slug}`}</div>
          <h1 className="zf-h mt-1.5">Edit factory</h1>
        </div>
        <FactoryForm
          mode="edit"
          action={updateFactoryAction.bind(null, factory.id)}
          initial={{
            name: factory.name,
            slug: factory.slug,
            description: factory.description ?? "",
            subnetCidr: factory.subnetCidr,
          }}
          cancelHref={routes.factory(factory.id)}
          networkName={factory.dockerNetworkName}
        />
      </Content>
    </AppShell>
  );
}
