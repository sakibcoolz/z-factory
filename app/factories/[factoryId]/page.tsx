import type { Metadata } from "next";
import { DeleteFactory } from "@/components/factories/delete-factory";
import { FactoryExplorer } from "@/components/factories/factory-explorer";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { Button } from "@/components/ui/button";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { formatUtc } from "@/lib/factories/format";
import { routes } from "@/lib/navigation/routes";
import { deleteFactoryAction } from "../actions";
import { loadFactory } from "./load-factory";

export const metadata: Metadata = { title: "Factory" };

export const dynamic = "force-dynamic";

type FactoryPageProps = {
  params: Promise<{ factoryId: string }>;
};

/** Factory overview: configuration, last persisted runtime state, edit and delete. */
export default async function FactoryPage({ params }: FactoryPageProps) {
  const { factoryId } = await params;
  const { factory, factories, docker } = await loadFactory(factoryId);

  return (
    <AppShell
      title={`${factory.name} — Z-FACTORY`}
      titleState={<RuntimeStatePill state={factory.runtimeStatus} />}
      activity="factories"
      badges={{ factories: factories.length }}
      sidebar={<FactoryExplorer factories={factories} activeFactoryId={factory.id} docker={docker} />}
      status={{
        tone: factory.runtimeStatus === "STOPPED" ? "off" : "ok",
        left: [`⎇ ${factory.slug}`, "overview"],
        right: [`updated ${formatUtc(factory.updatedAt)}`],
      }}
    >
      <EditorTabs
        tabs={[
          { label: "Factories", href: routes.factories() },
          { label: factory.name, active: true },
        ]}
        crumb={`factories › ${factory.slug}`}
      />
      <Content plain>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="zf-k">{`Factory · ${factory.slug}`}</div>
            <h1 className="zf-h mt-1.5">{factory.name}</h1>
            {factory.description ? <p className="mt-1 max-w-180 text-fg-muted">{factory.description}</p> : null}
          </div>
          <div className="flex items-start gap-1.5">
            <Button size="sm" href={routes.editFactory(factory.id)}>
              Edit
            </Button>
            <DeleteFactory factoryName={factory.name} action={deleteFactoryAction.bind(null, factory.id)} />
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2.5">
          <div className="zf-cell">
            <span className="zf-k">Runtime state</span>
            <RuntimeStatePill state={factory.runtimeStatus} />
            <span className="mono text-fg-dim">{`configuration ${factory.status.toLowerCase()}`}</span>
          </div>
          <div className="zf-cell">
            <span className="zf-k">Docker network</span>
            <span className="mono break-all text-fg-strong">{factory.dockerNetworkName}</span>
            <span className="mono text-fg-dim">created when the factory first starts</span>
          </div>
          <div className="zf-cell">
            <span className="zf-k">Subnet</span>
            <span className="mono text-fg-strong">{factory.subnetCidr}</span>
            <span className="mono text-fg-dim">isolated per factory</span>
          </div>
          <div className="zf-cell">
            <span className="zf-k">Devices</span>
            <span className="mono text-fg-strong">{`${factory.deviceCount} devices · ${factory.plcCount} PLCs`}</span>
            <span className="mono text-fg-dim">
              {factory.lastEvent
                ? `${factory.lastEvent.type} · ${formatUtc(factory.lastEvent.occurredAt)}`
                : "no events"}
            </span>
          </div>
        </div>
        <p className="zf-sub mt-auto">
          This is the factory&apos;s desired configuration. Devices, the designer and runtime control for stored
          factories arrive with Phase 02 and Phase 03; nothing here starts Docker.
        </p>
      </Content>
    </AppShell>
  );
}
