"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { SideBar, SideSection } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { type OperationButton, OperationForm } from "@/components/ui/operation-form";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { type FactorySceneView, SCENE_SCALE_RANGE } from "@/lib/domain/scene-view";
import { routes } from "@/lib/navigation/routes";
import type { OperationState } from "@/lib/plc/operation-state";
import type { CameraView } from "./factory-canvas";

/** WebGL only exists in the browser, and three.js is not needed until the scene is shown. */
const FactoryCanvas = dynamic(() => import("./factory-canvas"), {
  ssr: false,
  loading: () => <p className="zf-sub p-4">Loading the 3D scene…</p>,
});

type SceneViewProps = {
  scene: FactorySceneView;
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
export function SceneView({ scene, transformAction, plcLinks, designerHref }: SceneViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraView>("iso");
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
          <FactoryCanvas scene={scene} selectedId={selectedId} onSelect={setSelectedId} camera={camera} />
        ) : (
          <p className="zf-error p-4" role="alert">
            This browser cannot show the 3D scene (WebGL is not available). The devices are listed on the right.
          </p>
        )}
        <div className="zf-stage-overlay zf-k left-2.5 gap-3">
          <span>— signal</span>
          <span>- - network</span>
          <span>· · feedback</span>
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
              <span className="mono">{device.name}</span>
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
                ["State", <RuntimeStatePill key="v" state={selected.runtimeStatus} />],
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
