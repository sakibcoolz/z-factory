"use client";

import { Clone, Line, OrbitControls, useGLTF } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Component, type ReactNode, type RefObject, Suspense, useEffect, useMemo, useRef } from "react";
import { Box3, type Material, MathUtils, type Mesh, Vector3 } from "three";
import type { StateTone } from "@/lib/domain/runtime-state";
import type { FactorySceneView, SceneAssetView, SceneDeviceView } from "@/lib/domain/scene-view";
import { fitScale } from "@/lib/scene/placeholders";
import { type ConnectionAppearance, type DeviceAppearance, sceneIsAnimated } from "@/lib/scene/state";
import { DevicePlaceholder } from "./device-placeholder";

/**
 * 2q — the WebGL scene of a stored factory. Every device is drawn from the 3D asset of
 * its catalog model, fitted into the space of its category, or as that category's
 * generic shape when the model has no asset or the asset cannot be loaded.
 *
 * The scene shows; it decides nothing. Positions, connections and states come in as
 * props. Runtime state is drawn around a device (a ring on the floor, a frame around its
 * space) and along its connections, never into its model: the loaded asset is shared by
 * all instances and stays as it was stored.
 */

export type CameraView = "iso" | "top" | "front";

export type SceneColors = {
  body: string;
  accent: string;
  selection: string;
  line: string;
  grid: string;
  gridStrong: string;
  /** State colours of the design system, by tone. `off` has none: a stopped device is plain. */
  tone: Record<Exclude<StateTone, "off">, string>;
};

type FactoryCanvasProps = {
  scene: FactorySceneView;
  selectedId: string | null;
  onSelect: (deviceId: string | null) => void;
  camera: CameraView;
  /** How each device is shown right now, by device id. */
  devices: ReadonlyMap<string, DeviceAppearance>;
  /** How each connection is shown right now, by connection id. */
  connections: ReadonlyMap<string, ConnectionAppearance>;
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
    tone: {
      run: token("--color-ok"),
      flt: token("--color-accent"),
      deg: token("--color-warn"),
      disc: token("--color-ext"),
      start: token("--color-info"),
    },
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

/** The twelve edges of a box of the given size standing on the floor, as pairs of points. */
function frameSegments([width, height, depth]: readonly [number, number, number]): Array<[number, number, number]> {
  const x = width / 2;
  const z = depth / 2;
  const corners = (y: number): Array<[number, number, number]> => [
    [-x, y, -z],
    [x, y, -z],
    [x, y, z],
    [-x, y, z],
  ];
  const bottom = corners(0);
  const top = corners(height);
  const next = (index: number) => (index + 1) % 4;
  return [0, 1, 2, 3].flatMap((index) => [
    bottom[index] as [number, number, number],
    bottom[next(index)] as [number, number, number],
    top[index] as [number, number, number],
    top[next(index)] as [number, number, number],
    bottom[index] as [number, number, number],
    top[index] as [number, number, number],
  ]);
}

/**
 * Runtime state drawn around a device: a ring on the floor and, for every state but
 * starting and stopping, a frame around the device's space. A fault pulses.
 */
function StateOverlay({
  appearance,
  size,
  scale,
  colors,
}: {
  appearance: DeviceAppearance;
  size: readonly [number, number, number];
  scale: number;
  colors: SceneColors;
}) {
  const ring = useRef<Mesh>(null);
  const segments = useMemo(() => frameSegments([size[0] * 1.08, size[1] * 1.04, size[2] * 1.08]), [size]);
  useFrame(({ clock }) => {
    if (!ring.current) return;
    // Between 55 % and 100 %, about once a second; a steady ring for every other state.
    const strength = appearance.pulse ? 0.775 + 0.225 * Math.sin(clock.elapsedTime * 6) : 1;
    (ring.current.material as Material).opacity = strength;
    ring.current.scale.setScalar(appearance.pulse ? 1 + (1 - strength) * 0.3 : 1);
  });
  if (appearance.tone === "off") return null;
  const color = colors.tone[appearance.tone];
  const radius = Math.max(size[0], size[2]) * scale * 0.62;

  return (
    <group>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.02}>
        <ringGeometry args={[radius, radius + 0.09, 48]} />
        <meshBasicMaterial color={color} transparent />
      </mesh>
      {appearance.tone === "start" ? null : (
        <group scale={scale}>
          <Line points={segments} segments color={color} lineWidth={appearance.tone === "flt" ? 2.5 : 1.5} />
        </group>
      )}
    </group>
  );
}

function Device({
  device,
  appearance,
  selected,
  colors,
  onSelect,
}: {
  device: SceneDeviceView;
  appearance: DeviceAppearance | undefined;
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
      {appearance ? (
        <group rotation-y={MathUtils.degToRad(device.rotationDeg)}>
          <StateOverlay appearance={appearance} size={device.placeholder.size} scale={device.scale} colors={colors} />
        </group>
      ) : null}
      {selected ? (
        <mesh rotation-x={-Math.PI / 2} position-y={0.01}>
          <ringGeometry
            args={[Math.max(width, depth) * device.scale * 0.85, Math.max(width, depth) * device.scale * 0.9, 48]}
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

/**
 * One connection on the floor. Its colour and movement come from the state of its two
 * ends: red when either is faulted, green and flowing when both run, plain otherwise.
 */
function Connection({
  from,
  to,
  line,
  appearance,
  colors,
}: {
  from: SceneDeviceView;
  to: SceneDeviceView;
  line: FactorySceneView["connections"][number]["line"];
  appearance: ConnectionAppearance | undefined;
  colors: SceneColors;
}) {
  const ref = useRef<{ material: { dashOffset: number } }>(null);
  const tone = appearance?.tone ?? "idle";
  const flowing = appearance?.animated ?? false;
  useFrame((_, delta) => {
    // Flow runs from the source to the target while both ends run, and stands still otherwise.
    if (flowing && ref.current) ref.current.material.dashOffset -= delta * 0.9;
  });
  const style = flowing ? { dashed: true, dash: 0.28, gap: 0.16 } : DASH[line];

  return (
    <Line
      // drei's line has no public type for its ref; only the dash offset is touched.
      ref={ref as never}
      points={[
        [from.position.x, 0.04, from.position.z],
        [to.position.x, 0.04, to.position.z],
      ]}
      color={tone === "fault" ? colors.tone.flt : tone === "active" ? colors.tone.run : colors.line}
      lineWidth={tone === "idle" ? 1.5 : 2.5}
      dashed={style.dashed}
      dashSize={style.dash}
      gapSize={style.gap}
    />
  );
}

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

export default function FactoryCanvas({
  scene,
  selectedId,
  onSelect,
  camera,
  devices,
  connections,
}: FactoryCanvasProps) {
  const colors = useMemo(() => readColors(), []);
  const byId = useMemo(() => new Map(scene.devices.map((device) => [device.id, device])), [scene.devices]);
  const labels = useRef(new Map<string, HTMLElement>());
  const floor = scene.extent * 2;
  // Draw continuously only while something moves; otherwise only when something changes.
  const animated = sceneIsAnimated(devices.values(), connections.values());

  return (
    <>
      <Canvas
        frameloop={animated ? "always" : "demand"}
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
          return (
            <Connection
              key={connection.id}
              from={from}
              to={to}
              line={connection.line}
              appearance={connections.get(connection.id)}
              colors={colors}
            />
          );
        })}

        {scene.devices.map((device) => (
          <Device
            key={device.id}
            device={device}
            appearance={devices.get(device.id)}
            selected={device.id === selectedId}
            colors={colors}
            onSelect={onSelect}
          />
        ))}

        <OrbitControls makeDefault maxPolarAngle={Math.PI / 2.05} minDistance={1.5} maxDistance={scene.extent * 6} />
      </Canvas>
      <div className="zf-scene-labels" aria-hidden="true">
        {scene.devices.map((device) => {
          const appearance = devices.get(device.id);
          return (
            <div
              key={device.id}
              ref={(element) => {
                if (element) labels.current.set(device.id, element);
                else labels.current.delete(device.id);
              }}
              className="zf-scene-label"
              data-selected={device.id === selectedId}
              data-tone={appearance?.tone ?? "off"}
              hidden
            >
              <b>{device.name}</b>
              <span>{appearance?.label ?? ""}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
