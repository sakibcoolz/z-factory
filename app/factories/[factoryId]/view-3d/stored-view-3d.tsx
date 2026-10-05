import { LiveRefresh } from "@/components/live/live-refresh";
import { SceneView } from "@/components/scene/scene-view";
import { AppShell } from "@/components/shell/app-shell";
import { EditorTabs, Toolbar } from "@/components/shell/editor";
import { Button } from "@/components/ui/button";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { getDb } from "@/lib/db/client";
import { routes } from "@/lib/navigation/routes";
import { getFactoryScene } from "@/lib/services/scene-service";
import { loadStoredFactory } from "../load-stored-factory";
import { sceneTransformAction } from "./actions";

/**
 * 2q for a stored factory: its devices and connections in three dimensions. A picture
 * of what the designer and the topology view hold, with no state of its own.
 */
export async function StoredView3d({ factoryId }: { factoryId: string }) {
  const { actor, factory } = await loadStoredFactory(factoryId);
  const scene = await getFactoryScene(getDb(), actor, factory.id);
  const withAsset = scene.devices.filter((device) => device.asset).length;
  const plcLinks = Object.fromEntries(
    scene.devices.filter((device) => device.isPlc).map((device) => [device.id, routes.plc(factory.id, device.id)]),
  );

  return (
    <AppShell
      title={`3D — ${factory.name}`}
      command="visualization · not the authoritative model"
      titleState={<RuntimeStatePill state={factory.runtimeStatus} />}
      activity="factories"
      status={{
        tone: factory.runtimeStatus === "STOPPED" ? "off" : "ok",
        left: [`⎇ ${factory.slug}`, "3d", `${scene.devices.length} devices · ${scene.connections.length} connections`],
        right: [`${withAsset}/${scene.devices.length} catalog assets`, "three.js"],
      }}
    >
      {/* Stored states change with recorded events; the scene follows them. */}
      <LiveRefresh streamUrl={routes.stream(factory.id)} />
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: "Designer", href: routes.designer(factory.id) },
          { label: "Topology", href: routes.topology(factory.id) },
          { label: "3D", active: true },
        ]}
        crumb={`${factory.slug} › 3d`}
      />
      <Toolbar summary="drag to orbit · scroll to zoom · right-drag to pan · click a device to select it">
        <Button size="sm" variant="ghost" href={routes.topology(factory.id)}>
          2D topology
        </Button>
        <Button size="sm" variant="primary" href={routes.designer(factory.id)}>
          Edit in designer
        </Button>
      </Toolbar>
      <SceneView
        scene={scene}
        transformAction={sceneTransformAction.bind(null, factory.id)}
        plcLinks={plcLinks}
        designerHref={routes.designer(factory.id)}
      />
    </AppShell>
  );
}
