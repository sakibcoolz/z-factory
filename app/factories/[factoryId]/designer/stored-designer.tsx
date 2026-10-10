import { DevicePalette } from "@/components/canvas/device-palette";
import { LlmContextPanel } from "@/components/agent/llm-context";
import { TopologyCanvas } from "@/components/canvas/topology-canvas";
import { LiveRefresh } from "@/components/live/live-refresh";
import { AppShell } from "@/components/shell/app-shell";
import { EditorTabs, Toolbar } from "@/components/shell/editor";
import { SideBar } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { buildTopologyContext } from "@/lib/agent/contexts/design-pages";
import { getDb } from "@/lib/db/client";
import { routes } from "@/lib/navigation/routes";
import { getTopology } from "@/lib/services/topology-service";
import { loadFactory } from "../load-factory";
import {
  connectWireAction,
  disconnectWireAction,
  linkDevicesAction,
  loadPairWiringAction,
  moveDevicesAction,
  placeDeviceAction,
  reconnectWireAction,
  removeDeviceAction,
  renameDeviceAction,
  unlinkDevicesAction,
} from "./actions";

type StoredCanvasProps = { factoryId: string; mode: "designer" | "topology" };

/**
 * 2d / 2o for a stored factory: the designer (palette, canvas, inspector) or the
 * read-only topology view of the same data.
 */
export async function StoredCanvas({ factoryId, mode }: StoredCanvasProps) {
  const { factory, actor } = await loadFactory(factoryId);
  const view = await getTopology(getDb(), actor, factory.id);
  const designing = mode === "designer";
  // Every device has a screen: a controller the PLC screens, any other device its own (TASK-308).
  const plcLinks = Object.fromEntries(
    view.nodes.map((node) => [
      node.id,
      node.architectureType ? routes.plc(factory.id, node.id) : routes.device(factory.id, node.id),
    ]),
  );
  const faulted = view.nodes.filter((node) => node.runtimeStatus === "FAULTED").length;

  return (
    <AppShell
      title={`${factory.name} — Z-FACTORY`}
      titleState={<RuntimeStatePill state={factory.runtimeStatus} />}
      activity="factories"
      sidebar={
        designing ? (
          <SideBar title="Palette">
            <DevicePalette
              groups={view.palette}
              onPlace={placeDeviceAction.bind(null, factory.id)}
              deviceCount={view.nodes.length}
            />
          </SideBar>
        ) : undefined
      }
      status={{
        tone: faulted > 0 ? "flt" : factory.runtimeStatus === "STOPPED" ? "off" : "ok",
        left: [`⎇ ${factory.slug}`, mode, `${view.nodes.length} devices · ${view.edges.length} connections`],
        right: [faulted > 0 ? `${faulted} faulted` : "no faults"],
      }}
    >
      {/* State changes arrive as events; the overlay follows them without waiting for a poll. */}
      <LiveRefresh streamUrl={routes.stream(factory.id)} />
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: "Designer", href: routes.designer(factory.id), active: designing },
          { label: "Topology", href: routes.topology(factory.id), active: !designing },
          { label: "3D", href: routes.view3d(factory.id) },
        ]}
        crumb={`${factory.slug} › ${mode}`}
      />
      <Toolbar
        summary={
          designing
            ? `saved as you go · ${view.nodes.length} devices · ${view.edges.length} connections`
            : "read-only · — signal · - - network · · · feedback · green: both ends running · red: fault"
        }
      >
        <Button size="sm" variant="ghost" href={routes.factory(factory.id)}>
          Overview
        </Button>
        {designing ? (
          <Button size="sm" variant="ghost" href={routes.topology(factory.id)}>
            View only
          </Button>
        ) : (
          <Button size="sm" variant="primary" href={routes.designer(factory.id)}>
            Edit in designer
          </Button>
        )}
      </Toolbar>
      <TopologyCanvas
        view={{ nodes: view.nodes, edges: view.edges }}
        plcLinks={plcLinks}
        actions={
          designing
            ? {
                place: placeDeviceAction.bind(null, factory.id),
                move: moveDevicesAction.bind(null, factory.id),
                link: linkDevicesAction.bind(null, factory.id),
                unlink: unlinkDevicesAction.bind(null, factory.id),
                remove: removeDeviceAction.bind(null, factory.id),
                rename: renameDeviceAction.bind(null, factory.id),
                wiring: {
                  load: loadPairWiringAction.bind(null, factory.id),
                  connect: connectWireAction.bind(null, factory.id),
                  reconnect: reconnectWireAction.bind(null, factory.id),
                  disconnect: disconnectWireAction.bind(null, factory.id),
                },
              }
            : undefined
        }
      />
      <LlmContextPanel document={buildTopologyContext({ factory, view, mode })} />
    </AppShell>
  );
}
