"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { STREAM_STATUS_LABEL, type StreamStatus, useFactoryStream } from "@/components/live/use-factory-stream";
import { SideBar, SideSection } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { type OperationButton, OperationForm } from "@/components/ui/operation-form";
import { KeyValue } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import type { LiveDeviceState } from "@/lib/domain/live";
import { type FactorySceneView, SCENE_SCALE_RANGE } from "@/lib/domain/scene-view";
import { routes } from "@/lib/navigation/routes";
import type { OperationState } from "@/lib/plc/operation-state";
import { connectionAppearance, deviceAppearance } from "@/lib/scene/state";
import type { CameraView } from "./factory-canvas";

/** WebGL only exists in the browser, and three.js is not needed until the scene is shown. */
const FactoryCanvas = dynamic(() => import("./factory-canvas"), {
  ssr: false,
  loading: () => <p className="zf-sub p-4">Loading the 3D scene…</p>,
});

type SceneViewProps = {
  scene: FactorySceneView;
  /** The factory's live stream: device states come from it, not from this page's data. */
  streamUrl: string;
  /** Server action turning or sizing one device; `deviceId` and `operation` come with the form. */
  transformAction: (state: OperationState, formData: FormData) => Promise<OperationState>;
  /** Where each PLC's screens are, by device id. */
  plcLinks: Readonly<Record<string, string>>;
  designerHref: string;
};

const CAMERAS: ReadonlyArray<readonly [CameraView, string]> = [
  ["iso", "Iso"],
  ["top", "Top"],
  ["front", "Front"],
];

const STREAM_TONE: Record<StreamStatus, "run" | "deg" | "flt" | "neutral"> = {
  connecting: "neutral",
  live: "run",
  reconnecting: "deg",
  paused: "neutral",
  offline: "flt",
};

/** Where a device's state comes from, in words. */
const STATE_SOURCE: Record<LiveDeviceState["source"], string> = {
  LIVE: "simulator, live",
  SNAPSHOT: "last snapshot",
  STORED: "last stored",
};

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * 2q for a stored factory: the scene, a list of its devices, and what is selected. The
 * list does everything the canvas does, so the view can be used without a pointer and
 * without WebGL.
 */
export function SceneView({ scene, streamUrl, transformAction, plcLinks, designerHref }: SceneViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraView>("iso");
  const [liveStates, setLiveStates] = useState<ReadonlyMap<string, LiveDeviceState>>(new Map());

  const router = useRouter();
  const refresh = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(refresh.current), []);

  // The server works out each device's state from runtime memory and sends it; nothing here derives state from events.
  const stream = useFactoryStream(streamUrl, (message) => {
    const devices =
      message.kind === "snapshot" ? message.snapshot.devices : message.kind === "devices" ? message.devices : null;
    if (devices) setLiveStates(new Map(devices.map((device) => [device.deviceId, device])));
    // What the page itself shows of the factory (its overall state, the layout) is read again after an event.
    if (message.kind === "event" || message.kind === "reset") {
      clearTimeout(refresh.current);
      refresh.current = setTimeout(() => router.refresh(), 600);
    }
  });
  const streamLive = stream === "live";
  const appearances = useMemo(
    () =>
      new Map(
        scene.devices.map((device) => [
          device.id,
          deviceAppearance(device.runtimeStatus, liveStates.get(device.id), streamLive),
        ]),
      ),
    [scene.devices, liveStates, streamLive],
  );
  const connectionAppearances = useMemo(
    () =>
      new Map(
        scene.connections.map((connection) => [
          connection.id,
          connectionAppearance(appearances.get(connection.sourceId), appearances.get(connection.targetId)),
        ]),
      ),
    [scene.connections, appearances],
  );
  const supported = useMemo(() => (typeof document === "undefined" ? true : webglAvailable()), []);
  const selected = scene.devices.find((device) => device.id === selectedId) ?? null;
  const withAsset = scene.devices.filter((device) => device.asset).length;

  const transformButtons = (scale: number): OperationButton[] => [
    { operation: "rotate-left", label: "⟲ 45°", pendingLabel: "Turning…", variant: "ghost" },
    { operation: "rotate-right", label: "⟳ 45°", pendingLabel: "Turning…", variant: "ghost" },
    {
      operation: "scale-down",
      label: "Smaller",
      pendingLabel: "Sizing…",
      variant: "ghost",
      disabled: scale <= SCENE_SCALE_RANGE.min,
    },
    {
      operation: "scale-up",
      label: "Larger",
      pendingLabel: "Sizing…",
      variant: "ghost",
      disabled: scale >= SCENE_SCALE_RANGE.max,
    },
    { operation: "reset", label: "Reset", pendingLabel: "Resetting…", variant: "ghost" },
  ];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="zf-scene3d">
        {scene.devices.length === 0 ? (
          <p className="zf-sub p-4">This factory has no devices yet. Add them in the designer; they appear here.</p>
        ) : supported ? (
          <FactoryCanvas
            scene={scene}
            selectedId={selectedId}
            onSelect={setSelectedId}
            camera={camera}
            devices={appearances}
            connections={connectionAppearances}
          />
        ) : (
          <p className="zf-error p-4" role="alert">
            This browser cannot show the 3D scene (WebGL is not available). The devices are listed on the right.
          </p>
        )}
        <div className="zf-stage-overlay zf-k left-2.5 gap-3">
          <span>— signal</span>
          <span>- - network</span>
          <span>· · feedback</span>
          <span className="text-ok">running</span>
          <span className="text-fault-fg">fault</span>
          <span className="text-warn-fg">degraded · stale</span>
          <span className="text-ext">no answer</span>
        </div>
        <div className="zf-stage-overlay top-2.5 bottom-auto left-2.5" role="status" aria-label="Live state">
          <StatePill tone={STREAM_TONE[stream]}>{`state · ${STREAM_STATUS_LABEL[stream]}`}</StatePill>
        </div>
        <div className="zf-stage-overlay right-2.5" role="group" aria-label="Camera">
          {CAMERAS.map(([view, label]) => (
            <button
              key={view}
              type="button"
              className="zf-btn"
              data-size="sm"
              data-variant={camera === view ? "default" : "ghost"}
              aria-pressed={camera === view}
              onClick={() => setCamera(view)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <SideBar title="Scene" edge="left" className="w-62.5">
        <SideSection title={`Devices · ${scene.devices.length}`}>
          {scene.devices.map((device) => (
            <button
              key={device.id}
              type="button"
              className="zf-scene-pick"
              aria-pressed={device.id === selectedId}
              onClick={() => setSelectedId(device.id === selectedId ? null : device.id)}
            >
              <span className="flex items-center gap-2">
                <StatePill tone={appearances.get(device.id)?.tone ?? "off"} label={appearances.get(device.id)?.label} />
                <span className="mono">{device.name}</span>
              </span>
              <span className="zf-k">{device.asset ? `asset v${device.asset.version}` : "placeholder"}</span>
            </button>
          ))}
        </SideSection>
        {selected ? (
          <SideSection title={selected.name}>
            <KeyValue
              rows={[
                ["Type", selected.categoryName],
                ["Model", `${selected.manufacturer} ${selected.modelName}`],
                ["Role", selected.role ?? "—"],
                [
                  "State",
                  <StatePill key="v" tone={appearances.get(selected.id)?.tone ?? "off"}>
                    {appearances.get(selected.id)?.label}
                  </StatePill>,
                ],
                [
                  "State from",
                  <span key="v" className="mono">
                    {appearances.get(selected.id)?.live
                      ? STATE_SOURCE[liveStates.get(selected.id)?.source ?? "STORED"]
                      : "not confirmed"}
                  </span>,
                ],
                [
                  "3D asset",
                  selected.asset ? (
                    <span key="v" className="mono">{`catalog asset v${selected.asset.version}`}</span>
                  ) : (
                    <StatePill key="v" tone="off">
                      generic shape
                    </StatePill>
                  ),
                ],
                ["Placing", <span key="v" className="mono">{`${selected.rotationDeg}° · ×${selected.scale}`}</span>],
              ]}
            />
            <div className="flex flex-col gap-2 px-4 py-2.5">
              <OperationForm
                // The buttons belong to this device: another selection starts them afresh.
                key={selected.id}
                label={`Placing of ${selected.name}`}
                size="sm"
                action={transformAction}
                fields={{ deviceId: selected.id }}
                buttons={transformButtons(selected.scale)}
              />
              <div className="flex flex-wrap gap-1.5">
                {plcLinks[selected.id] ? (
                  <Button size="sm" href={plcLinks[selected.id]}>
                    Open PLC
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" href={routes.catalog({ model: selected.modelId })}>
                  Catalog model
                </Button>
              </div>
            </div>
          </SideSection>
        ) : (
          <SideSection title="Selection">
            <p className="zf-sub px-4 py-2">
              Select a device in the scene or in the list to see it and to turn or size it.
            </p>
          </SideSection>
        )}
        <SideSection title="About this view">
          <p className="zf-sub px-4 py-2">
            {`${withAsset} of ${scene.devices.length} devices use their catalog model's 3D asset; the others are drawn as the generic shape of their type. Devices stand where the designer places them.`}
          </p>
          <div className="px-4 pb-3">
            <Button size="sm" variant="ghost" href={designerHref}>
              Edit layout in designer
            </Button>
          </div>
        </SideSection>
      </SideBar>
    </div>
  );
}
