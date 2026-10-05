"use client";

import { Clone, Line, OrbitControls, useGLTF } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Component, type ReactNode, type RefObject, Suspense, useEffect, useMemo, useRef } from "react";
import { Box3, MathUtils, Vector3 } from "three";
import { runtimeStateLabel } from "@/lib/domain/runtime-state";
import type { FactorySceneView, SceneAssetView, SceneDeviceView } from "@/lib/domain/scene-view";
import { fitScale } from "@/lib/scene/placeholders";
import { DevicePlaceholder } from "./device-placeholder";

/**
 * 2q — the WebGL scene of a stored factory. Every device is drawn from the 3D asset of
 * its catalog model, fitted into the space of its category, or as that category's
 * generic shape when the model has no asset or the asset cannot be loaded.
 *
 * The scene shows; it decides nothing. Positions, connections and states come in as
 * props. Runtime colouring is not done here (TASK-404).
 */

export type CameraView = "iso" | "top" | "front";

export type SceneColors = {
  body: string;
  accent: string;
  selection: string;
  line: string;
  grid: string;
  gridStrong: string;
};

type FactoryCanvasProps = {
  scene: FactorySceneView;
  selectedId: string | null;
  onSelect: (deviceId: string | null) => void;
  camera: CameraView;
};

/** Colour tokens of the design system, read where the scene is mounted. */
function readColors(): SceneColors {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim() || "gray";
  return {
    body: token("--color-fg-dim"),
    accent: token("--color-fg-faint"),
    selection: token("--color-focus"),
    line: token("--color-fg-muted"),
    grid: token("--color-scene-grid"),
    gridStrong: token("--color-line-strong"),
  };
}

/** Keeps drawing the scene when one model fails: that device falls back to its placeholder. */
class AssetBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * The catalog asset of a device. The file is loaded once per asset and shared by every
 * instance; each instance draws its own copy of the loaded scene. No decoder is fetched
 * from elsewhere: a file that needs one fails to load and the placeholder is shown.
 */
function CatalogModel({ asset, space }: { asset: SceneAssetView; space: SceneDeviceView["placeholder"]["size"] }) {
  const { scene } = useGLTF(asset.url, false, false);
  const fit = useMemo(() => {
    const box = new Box3().setFromObject(scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    return {
      scale: asset.scale ?? fitScale([size.x, size.y, size.z], space),
      // Centred on its footprint and standing on the floor, whatever the file's origin is.
      offset: [-center.x, -box.min.y, -center.z] as const,
    };
  }, [scene, asset.scale, space]);

  return (
    <group rotation-y={MathUtils.degToRad(asset.rotationYDeg)} scale={fit.scale}>
      <group position={fit.offset}>
        <Clone object={scene} />
      </group>
    </group>
  );
}

function Device({
  device,
  selected,
  colors,
  onSelect,
}: {
  device: SceneDeviceView;
  selected: boolean;
  colors: SceneColors;
  onSelect: (deviceId: string) => void;
}) {
  const [width, , depth] = device.placeholder.size;
  const placeholder = <DevicePlaceholder spec={device.placeholder} colors={colors} />;
  const select = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelect(device.id);
  };

  return (
    <group position={[device.position.x, 0, device.position.z]}>
      <group rotation-y={MathUtils.degToRad(device.rotationDeg)} scale={device.scale} onClick={select}>
        {device.asset ? (
          <AssetBoundary key={device.asset.id} fallback={placeholder}>
            <Suspense fallback={placeholder}>
              <CatalogModel asset={device.asset} space={device.placeholder.size} />
            </Suspense>
          </AssetBoundary>
        ) : (
          placeholder
        )}
      </group>
      {selected ? (
        <mesh rotation-x={-Math.PI / 2} position-y={0.01}>
          <ringGeometry
            args={[Math.max(width, depth) * device.scale * 0.75, Math.max(width, depth) * device.scale * 0.82, 48]}
          />
          <meshBasicMaterial color={colors.selection} />
        </mesh>
      ) : null}
    </group>
  );
}

const DASH: Record<FactorySceneView["connections"][number]["line"], { dashed: boolean; dash: number; gap: number }> = {
  signal: { dashed: false, dash: 1, gap: 0 },
  network: { dashed: true, dash: 0.3, gap: 0.18 },
  feedback: { dashed: true, dash: 0.08, gap: 0.12 },
};

type LabelElements = RefObject<Map<string, HTMLElement>>;

/**
 * Keeps each device's label above the device on screen. The labels are ordinary page
 * elements over the canvas; here they are only moved, once per drawn frame.
 */
function LabelProjector({ devices, labels }: { devices: readonly SceneDeviceView[]; labels: LabelElements }) {
  const point = useMemo(() => new Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const device of devices) {
      const element = labels.current.get(device.id);
      if (!element) continue;
      point.set(device.position.x, device.placeholder.size[1] * device.scale + 0.3, device.position.z).project(camera);
      // Behind the camera or beyond the far plane: nothing to label.
      const visible = point.z > -1 && point.z < 1;
      element.hidden = !visible;
      if (!visible) continue;
      const x = ((point.x + 1) / 2) * size.width;
      const y = ((1 - point.y) / 2) * size.height;
      element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  });
  return null;
}

/** Puts the camera where the chosen view looks from, and the controls' target on the floor's centre. */
function CameraRig({ view, extent }: { view: CameraView; extent: number }) {
  const { camera, controls, invalidate } = useThree();
  useEffect(() => {
    const positions: Record<CameraView, [number, number, number]> = {
      iso: [extent * 1.1, extent * 0.9, extent * 1.3],
      top: [0, extent * 2.4, 0.001],
      front: [0, extent * 0.6, extent * 2],
    };
    camera.position.set(...positions[view]);
    camera.lookAt(0, 0, 0);
    const orbit = controls as { target?: Vector3; update?: () => void } | null;
    orbit?.target?.set(0, 0, 0);
    orbit?.update?.();
    invalidate();
  }, [view, extent, camera, controls, invalidate]);
  return null;
}

export default function FactoryCanvas({ scene, selectedId, onSelect, camera }: FactoryCanvasProps) {
  const colors = useMemo(() => readColors(), []);
  const byId = useMemo(() => new Map(scene.devices.map((device) => [device.id, device])), [scene.devices]);
  const labels = useRef(new Map<string, HTMLElement>());
  const floor = scene.extent * 2;

  return (
    <>
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ fov: 42, near: 0.1, far: 600 }}
        onPointerMissed={() => onSelect(null)}
        aria-label={`3D view of ${scene.factory.name}`}
        role="img"
      >
        <CameraRig view={camera} extent={scene.extent} />
        <LabelProjector devices={scene.devices} labels={labels} />
        <ambientLight intensity={0.9} />
        <hemisphereLight intensity={0.6} />
        <directionalLight position={[scene.extent, scene.extent * 2, scene.extent]} intensity={1.6} />
        <gridHelper args={[floor, Math.round(floor), colors.gridStrong, colors.grid]} />

        {scene.connections.map((connection) => {
          const from = byId.get(connection.sourceId);
          const to = byId.get(connection.targetId);
          if (!from || !to) return null;
          const style = DASH[connection.line];
          return (
            <Line
              key={connection.id}
              points={[
                [from.position.x, 0.04, from.position.z],
                [to.position.x, 0.04, to.position.z],
              ]}
              color={colors.line}
              lineWidth={1.5}
              dashed={style.dashed}
              dashSize={style.dash}
              gapSize={style.gap}
            />
          );
        })}

        {scene.devices.map((device) => (
          <Device
            key={device.id}
            device={device}
            selected={device.id === selectedId}
            colors={colors}
            onSelect={onSelect}
          />
        ))}

        <OrbitControls makeDefault maxPolarAngle={Math.PI / 2.05} minDistance={1.5} maxDistance={scene.extent * 6} />
      </Canvas>
      <div className="zf-scene-labels" aria-hidden="true">
        {scene.devices.map((device) => (
          <div
            key={device.id}
            ref={(element) => {
              if (element) labels.current.set(device.id, element);
              else labels.current.delete(device.id);
            }}
            className="zf-scene-label"
            data-selected={device.id === selectedId}
            hidden
          >
            <b>{device.name}</b>
            <span>{runtimeStateLabel(device.runtimeStatus)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
