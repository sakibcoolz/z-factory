import type { Metadata } from "next";
import { DeleteFactory } from "@/components/factories/delete-factory";
import { DeviceTree } from "@/components/factories/device-tree";
import { FactoryExplorer } from "@/components/factories/factory-explorer";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { Button } from "@/components/ui/button";
import { SectionRule } from "@/components/ui/primitives";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { getDb } from "@/lib/db/client";
import { flattenDeviceTree } from "@/lib/domain/device-tree";
import { formatUtc } from "@/lib/factories/format";
import { routes } from "@/lib/navigation/routes";
import { getFactoryDeviceTree } from "@/lib/services/plc-config-service";
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
  const { factory, factories, docker, actor } = await loadFactory(factoryId);
  const devices = await getFactoryDeviceTree(getDb(), actor, factory.id);
  const deviceTotal = flattenDeviceTree(devices).length;

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
        <SectionRule>
          <span className="zf-k">{`Devices · ${deviceTotal}`}</span>
        </SectionRule>
        {devices.length > 0 ? (
          <DeviceTree factoryId={factory.id} nodes={devices} />
        ) : (
          <p className="zf-sub">No devices yet. Start with a PLC, then connect peripherals to it.</p>
        )}
        <div className="flex gap-2">
          <Button variant="primary" href={routes.designer(factory.id)}>
            Open designer
          </Button>
          <Button href={routes.newDevice(factory.id, "compact")}>Add compact PLC</Button>
          <Button href={routes.newDevice(factory.id, "modular")}>Add modular PLC</Button>
          <Button variant="ghost" href={routes.runtime(factory.id)}>
            Runtime
          </Button>
          <Button variant="ghost" href={routes.simulator(factory.id)}>
            Simulator
          </Button>
          <Button variant="ghost" href={routes.gateways(factory.id)}>
            Gateways
          </Button>
          <Button variant="ghost" href={routes.modules(factory.id)}>
            Process modules
          </Button>
          <Button variant="ghost" href={routes.view3d(factory.id)}>
            3D view
          </Button>
          <Button variant="ghost" href={routes.tags(factory.id)}>
            Live tags
          </Button>
          <Button variant="ghost" href={routes.events(factory.id)}>
            Events
          </Button>
        </div>
        <p className="zf-sub mt-auto">
          This is the factory&apos;s desired configuration; nothing here starts Docker. A PLC is started from its
          Runtime screen, the device simulation from the Simulator.
        </p>
      </Content>
    </AppShell>
  );
}
