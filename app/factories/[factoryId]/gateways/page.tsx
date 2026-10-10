import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LlmContextPanel } from "@/components/agent/llm-context";
import { GatewaysScreen } from "@/components/gateway/gateway-view";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { StatePill } from "@/components/ui/state-pill";
import { buildGatewaysContext } from "@/lib/agent/contexts/factory-engineering";
import { requireActor } from "@/lib/auth/actor";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { getGatewaysView } from "@/lib/services/gateway-service";
import { getGatewayDeps } from "@/lib/services/runtime-deps";
import { addGatewayAction, connectGatewayAction, gatewayConnectionAction, mapGatewayTagAction } from "./actions";

export const metadata: Metadata = { title: "Gateways" };

// Reads the database and the endpoints of this server process on every request.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GatewaysPageProps = { params: Promise<{ factoryId: string }> };

/** External gateways of a stored factory: endpoints, mapped tags and what a gateway may write. */
export default async function GatewaysPage({ params }: GatewaysPageProps) {
  const { factoryId } = await params;
  if (!UUID.test(factoryId)) notFound();
  const actor = await requireActor();
  const view = await getGatewaysView(getGatewayDeps(), actor, factoryId).catch((error: unknown) => {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  });
  const connections = view.gateways.flatMap((gateway) => gateway.connections);
  const open = connections.filter((connection) => connection.endpoint.listening);
  const failed = connections.filter((connection) => connection.enabled && !connection.endpoint.listening);
  const clients = open.reduce((count, connection) => count + connection.endpoint.clients, 0);

  return (
    <AppShell
      title={`Gateways — ${view.factory.name}`}
      titleState={
        <StatePill tone={failed.length > 0 ? "flt" : open.length > 0 ? "run" : "off"}>
          {failed.length > 0 ? "Endpoint not open" : open.length > 0 ? "Endpoints open" : "No endpoint"}
        </StatePill>
      }
      activity="factories"
      status={{
        tone: failed.length > 0 ? "flt" : open.length > 0 ? "ok" : "off",
        left: ["gateways", `${view.gateways.length} gateways · ${open.length} open endpoints`],
        right: [`${clients} connected`],
      }}
    >
      {open.length > 0 ? <AutoRefresh intervalMs={5000} /> : null}
      <EditorTabs
        tabs={[
          { label: view.factory.name, href: routes.factory(view.factory.id) },
          { label: "Gateways", active: true },
          { label: "Runtime", href: routes.runtime(view.factory.id) },
          { label: "Live tags", href: routes.tags(view.factory.id) },
        ]}
        crumb="Modbus TCP · writes reach command and setpoint tags only"
      />
      <Content plain>
        <GatewaysScreen
          view={view}
          actions={{
            add: addGatewayAction.bind(null, view.factory.id),
            connect: (gatewayDeviceId) => connectGatewayAction.bind(null, view.factory.id, gatewayDeviceId),
            connection: (connectionId) => gatewayConnectionAction.bind(null, view.factory.id, connectionId),
            mapTag: (connectionId) => mapGatewayTagAction.bind(null, view.factory.id, connectionId),
            mapHref: (connectionId) => routes.gatewayMap(view.factory.id, connectionId),
          }}
        />
        <LlmContextPanel document={buildGatewaysContext(view)} />
      </Content>
    </AppShell>
  );
}
