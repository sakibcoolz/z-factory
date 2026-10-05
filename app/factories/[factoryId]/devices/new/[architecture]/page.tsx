import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FactoryExplorer } from "@/components/factories/factory-explorer";
import { CompactPlcConfig } from "@/components/plc/compact-plc-config";
import { ModularPlcConfig } from "@/components/plc/modular-plc-config";
import { PlcCreateForm } from "@/components/plc/plc-create-form";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { getDb } from "@/lib/db/client";
import { isDemoFactory, isModularBenchFactory } from "@/lib/fixtures";
import { PLC_ARCHITECTURE_SLUGS, type PlcArchitectureSlug, routes } from "@/lib/navigation/routes";
import { listFactoryDevices, listPlcModels } from "@/lib/services/plc-config-service";
import { suggestDeviceName } from "@/lib/validation/io-address";
import { loadFactory } from "../../../load-factory";
import { createPlcAction } from "../../../plcs/actions";

export const metadata: Metadata = { title: "New PLC" };

// Stored factories read the database on every request.
export const dynamic = "force-dynamic";

type NewDevicePageProps = {
  params: Promise<{ factoryId: string; architecture: string }>;
};

const isArchitecture = (value: string): value is PlcArchitectureSlug =>
  (PLC_ARCHITECTURE_SLUGS as readonly string[]).includes(value);

/**
 * 2f / 2g — Device Configuration. Compact and modular PLCs are separate branches
 * (ADR-0003): built-in I/O with a pin view vs CPU › rack › slots › modules. For a stored
 * factory this is the first step: choosing the model, name and role. The pin view and
 * the rack follow on the new PLC's hardware screen.
 */
export default async function NewDevicePage({ params }: NewDevicePageProps) {
  const { factoryId, architecture } = await params;

  // The design-fixture factories keep their static screens.
  if (architecture === "compact" && isDemoFactory(factoryId)) return <CompactPlcConfig factoryId={factoryId} />;
  if (architecture === "modular" && isModularBenchFactory(factoryId)) return <ModularPlcConfig />;
  if (!isArchitecture(architecture) || isDemoFactory(factoryId) || isModularBenchFactory(factoryId)) notFound();

  const { factory, factories, docker, actor } = await loadFactory(factoryId);
  const db = getDb();
  const [models, devices] = await Promise.all([
    listPlcModels(db, architecture === "compact" ? "COMPACT" : "MODULAR"),
    listFactoryDevices(db, actor, factory.id),
  ]);

  return (
    <AppShell
      title={`${factory.name} — Z-FACTORY`}
      activity="factories"
      badges={{ factories: factories.length }}
      sidebar={<FactoryExplorer factories={factories} activeFactoryId={factory.id} docker={docker} />}
      status={{
        tone: "off",
        left: [`⎇ ${factory.slug}`, `new ${architecture} PLC`],
        right: [`${models.length} catalog models`],
      }}
    >
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: `New ${architecture} PLC`, active: true },
        ]}
        crumb={`factories › ${factory.slug} › new plc`}
      />
      <Content plain>
        <div>
          <div className="zf-k">
            {architecture === "compact" ? "Compact · built-in I/O" : "Modular · CPU, rack and modules"}
          </div>
          <h1 className="zf-h mt-1.5">{`New ${architecture} PLC`}</h1>
        </div>
        {models.length > 0 ? (
          <PlcCreateForm
            action={createPlcAction.bind(null, factory.id)}
            architecture={architecture}
            models={models}
            suggestedName={suggestDeviceName(
              "PLC",
              devices.map((device) => device.name),
            )}
            cancelHref={routes.factory(factory.id)}
          />
        ) : (
          <p className="zf-sub">The catalog has no {architecture} PLC. Run npm run db:seed to load the catalog.</p>
        )}
      </Content>
    </AppShell>
  );
}
