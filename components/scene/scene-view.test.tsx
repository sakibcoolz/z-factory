import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveDeviceState, LiveMessage } from "@/lib/domain/live";
import type { FactorySceneView, SceneDeviceView } from "@/lib/domain/scene-view";
import type { OperationState } from "@/lib/plc/operation-state";
import type { ConnectionAppearance, DeviceAppearance } from "@/lib/scene/state";
import { SceneView } from "./scene-view";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

/** Stands in for the WebGL canvas: shows what it was given and lets a test pick a device in it. */
vi.mock("next/dynamic", () => ({
  default: () =>
    function CanvasStub(props: {
      scene: FactorySceneView;
      selectedId: string | null;
      camera: string;
      onSelect: (id: string | null) => void;
      devices: ReadonlyMap<string, DeviceAppearance>;
      connections: ReadonlyMap<string, ConnectionAppearance>;
    }) {
      return (
        <div data-testid="canvas" data-selected={props.selectedId ?? ""} data-camera={props.camera}>
          {[...props.devices].map(([id, appearance]) => (
            <span key={id} data-testid={`shown-${id}`} data-tone={appearance.tone} data-pulse={appearance.pulse}>
              {appearance.label}
            </span>
          ))}
          {[...props.connections].map(([id, appearance]) => (
            <span key={id} data-testid={`line-${id}`} data-tone={appearance.tone} data-animated={appearance.animated} />
          ))}
          {props.scene.devices.map((device) => (
            <button key={device.id} type="button" onClick={() => props.onSelect(device.id)}>
              {`pick ${device.name}`}
            </button>
          ))}
          <button type="button" onClick={() => props.onSelect(null)}>
            pick nothing
          </button>
        </div>
      );
    },
}));

const device = (name: string, overrides: Partial<SceneDeviceView> = {}): SceneDeviceView => ({
  id: `id-${name}`,
  name,
  role: null,
  categoryCode: "MOTOR",
  categoryName: "Motor",
  manufacturer: "Generic / simulated",
  modelId: "model-motor",
  modelName: "Generic three-phase motor",
  isPlc: false,
  runtimeStatus: "STOPPED",
  position: { x: 0, z: 0 },
  rotationDeg: 0,
  scale: 1,
  asset: null,
  placeholder: { kind: "motor", size: [0.9, 0.55, 0.5] },
  ...overrides,
});

const SCENE: FactorySceneView = {
  factory: { id: "factory-1", name: "Line", slug: "line", runtimeStatus: "STOPPED" },
  devices: [
    device("PLC-01", { isPlc: true, categoryName: "PLC / programmable controller", role: "Pump station" }),
    device("M-01", {
      runtimeStatus: "RUNNING",
      rotationDeg: 90,
      scale: 1.25,
      asset: { id: "asset-1", version: 2, url: "/assets/models/asset-1/model.glb", scale: null, rotationYDeg: 0 },
    }),
    device("M-02", { scale: 4 }),
  ],
  connections: [],
  extent: 4,
};

function setup(scene: FactorySceneView = SCENE, result: OperationState = { notice: "Turned to 45°, size ×1." }) {
  const action = vi.fn(async (_state: OperationState, formData: FormData) => {
    void formData;
    return result;
  });
  render(
    <SceneView
      scene={scene}
      streamUrl="/factories/factory-1/stream"
      transformAction={action}
      plcLinks={{ "id-PLC-01": "/factories/factory-1/plcs/id-PLC-01" }}
      designerHref="/factories/factory-1/designer"
    />,
  );
  const submitted = () =>
    action.mock.calls.map(([, formData]) => [formData.get("deviceId"), formData.get("operation")]);
  return { action, submitted, inspector: within(screen.getByRole("complementary", { name: "Scene" })) };
}

/** The browser's EventSource, as far as the stream hook uses it. */
class FakeEventSource {
  static CLOSED = 2;
  static current: FakeEventSource;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.current = this;
  }
  addEventListener(kind: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  drop() {
    this.readyState = 0;
    act(() => this.onerror?.());
  }
  send(message: LiveMessage) {
    const event = { data: JSON.stringify(message), lastEventId: "" } as MessageEvent<string>;
    act(() => this.listeners.get(message.kind)?.forEach((listener) => listener(event)));
  }
}

const live = (
  name: string,
  status: LiveDeviceState["status"],
  extra: Partial<LiveDeviceState> = {},
): LiveDeviceState => ({
  deviceId: `id-${name}`,
  name,
  status,
  source: "LIVE",
  quality: "GOOD",
  at: "2026-10-05T07:00:00.000Z",
  ...extra,
});
const snapshot = (devices: LiveDeviceState[]): LiveMessage => ({
  kind: "snapshot",
  snapshot: { factoryId: "factory-1", at: "2026-10-05T07:00:00.000Z", tags: [], devices, activeAlarms: 0 },
});
const shown = (name: string) => screen.getByTestId(`shown-id-${name}`);

const getContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => {
  // jsdom has no WebGL; most tests are about a browser that has it.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as typeof getContext;
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = getContext;
  vi.unstubAllGlobals();
});

describe("SceneView", () => {
  it("lists every device with whether it is drawn from a catalog asset or as a generic shape", () => {
    const { inspector } = setup();
    expect(inspector.getByRole("button", { name: /PLC-01.*placeholder/ })).toBeInTheDocument();
    expect(inspector.getByRole("button", { name: /M-01.*asset v2/ })).toBeInTheDocument();
    expect(inspector.getByText(/1 of 3 devices use their catalog model's 3D asset/)).toBeInTheDocument();
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-selected", "");
  });

  it("selects from the list or from the scene, and shows the selected device", () => {
    const { inspector } = setup();
    fireEvent.click(inspector.getByRole("button", { name: /M-01/ }));
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-selected", "id-M-01");
    expect(inspector.getByRole("button", { name: /M-01/ })).toHaveAttribute("aria-pressed", "true");
    expect(inspector.getByText("catalog asset v2")).toBeInTheDocument();
    expect(inspector.getByText("90° · ×1.25")).toBeInTheDocument();
    // Stored as running, but nothing confirms it yet.
    expect(inspector.getByText("Running · stale")).toBeInTheDocument();
    expect(inspector.getByText("not confirmed")).toBeInTheDocument();

    // Picking in the scene does the same as the list.
    fireEvent.click(screen.getByRole("button", { name: "pick PLC-01" }));
    expect(inspector.getByRole("button", { name: /PLC-01/ })).toHaveAttribute("aria-pressed", "true");
    expect(inspector.getByText("generic shape")).toBeInTheDocument();
    expect(inspector.getByText("Pump station")).toBeInTheDocument();
    expect(inspector.getByRole("link", { name: "Open PLC" })).toHaveAttribute(
      "href",
      "/factories/factory-1/plcs/id-PLC-01",
    );

    fireEvent.click(screen.getByRole("button", { name: "pick nothing" }));
    expect(inspector.getByText(/Select a device in the scene or in the list/)).toBeInTheDocument();
    // A device that is not a PLC has no PLC screens to open.
    fireEvent.click(inspector.getByRole("button", { name: /M-02/ }));
    expect(inspector.queryByRole("link", { name: "Open PLC" })).not.toBeInTheDocument();
    expect(inspector.getByRole("link", { name: "Catalog model" })).toHaveAttribute(
      "href",
      "/catalog?model=model-motor",
    );
  });

  it("turns and sizes the selected device through the action, and reports the result", async () => {
    const { inspector, submitted } = setup();
    fireEvent.click(inspector.getByRole("button", { name: /M-01/ }));
    fireEvent.click(inspector.getByRole("button", { name: "⟲ 45°" }));
    expect(await inspector.findByText("Turned to 45°, size ×1.")).toBeInTheDocument();
    fireEvent.click(inspector.getByRole("button", { name: "Larger" }));
    await inspector.findByRole("button", { name: "Larger" });
    expect(submitted()).toEqual([
      ["id-M-01", "rotate-left"],
      ["id-M-01", "scale-up"],
    ]);
  });

  it("does not offer a size beyond the limits", () => {
    const { inspector } = setup();
    fireEvent.click(inspector.getByRole("button", { name: /M-02/ }));
    expect(inspector.getByRole("button", { name: "Larger" })).toBeDisabled();
    expect(inspector.getByRole("button", { name: "Smaller" })).toBeEnabled();
  });

  it("switches the camera view", () => {
    setup();
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-camera", "iso");
    fireEvent.click(screen.getByRole("button", { name: "Top" }));
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-camera", "top");
    expect(screen.getByRole("button", { name: "Top" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Iso" })).toHaveAttribute("aria-pressed", "false");
  });

  it("says so when the factory has nothing to show", () => {
    setup({ ...SCENE, devices: [] });
    expect(screen.getByText(/This factory has no devices yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();
  });

  it("stays usable without WebGL: no scene, but the devices and their details", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof getContext;
    const { inspector } = setup();
    expect(screen.getByRole("alert")).toHaveTextContent("WebGL is not available");
    expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();
    fireEvent.click(inspector.getByRole("button", { name: /M-01/ }));
    expect(inspector.getByText("catalog asset v2")).toBeInTheDocument();
  });

  const CONNECTED: FactorySceneView = {
    ...SCENE,
    connections: [
      {
        id: "plc-m1",
        relationship: "CONTROLS",
        sourceId: "id-PLC-01",
        targetId: "id-M-01",
        line: "signal",
        label: "controls",
        conductors: [],
      },
      {
        id: "m1-m2",
        relationship: "MECHANICALLY_DRIVES",
        sourceId: "id-M-01",
        targetId: "id-M-02",
        line: "signal",
        label: "drives",
        conductors: [],
      },
    ],
  };

  it("never shows a device as healthy before the live stream has confirmed it", () => {
    setup(CONNECTED);
    expect(FakeEventSource.current.url).toBe("/factories/factory-1/stream");
    expect(screen.getByRole("status", { name: "Live state" })).toHaveTextContent("state · connecting");
    // M-01 is stored as running: shown as stale, not green.
    expect(shown("M-01")).toHaveAttribute("data-tone", "deg");
    expect(shown("M-01")).toHaveTextContent("Running · stale");
    expect(shown("PLC-01")).toHaveAttribute("data-tone", "off");
    expect(screen.getByTestId("line-plc-m1")).toHaveAttribute("data-tone", "idle");
  });

  it("shows running devices green and their connection active once the stream reports them", () => {
    const { inspector } = setup(CONNECTED);
    FakeEventSource.current.open();
    FakeEventSource.current.send(
      snapshot([
        live("PLC-01", "RUNNING", { source: "STORED", at: null }),
        live("M-01", "RUNNING"),
        live("M-02", "STOPPED", { source: "SNAPSHOT", quality: "STALE" }),
      ]),
    );
    expect(screen.getByRole("status", { name: "Live state" })).toHaveTextContent("state · live");
    expect(shown("PLC-01")).toHaveAttribute("data-tone", "run");
    expect(shown("M-01")).toHaveAttribute("data-tone", "run");
    expect(shown("M-01")).toHaveTextContent(/^Running$/);
    // A stopped device is plain: neither healthy nor faulted.
    expect(shown("M-02")).toHaveAttribute("data-tone", "off");
    expect(screen.getByTestId("line-plc-m1")).toHaveAttribute("data-tone", "active");
    expect(screen.getByTestId("line-plc-m1")).toHaveAttribute("data-animated", "true");
    expect(screen.getByTestId("line-m1-m2")).toHaveAttribute("data-tone", "idle");

    fireEvent.click(inspector.getByRole("button", { name: /M-01/ }));
    expect(inspector.getByText("simulator, live")).toBeInTheDocument();
  });

  it("turns a faulted device and its connections red when the stream reports the fault, and back", () => {
    setup(CONNECTED);
    FakeEventSource.current.open();
    FakeEventSource.current.send(
      snapshot([live("PLC-01", "RUNNING"), live("M-01", "RUNNING"), live("M-02", "RUNNING")]),
    );
    const devices = (list: LiveDeviceState[]): LiveMessage => ({
      kind: "devices",
      factoryId: "factory-1",
      at: "2026-10-05T07:00:05.000Z",
      devices: list,
    });

    FakeEventSource.current.send(
      devices([live("PLC-01", "RUNNING"), live("M-01", "FAULTED"), live("M-02", "RUNNING")]),
    );
    expect(shown("M-01")).toHaveAttribute("data-tone", "flt");
    expect(shown("M-01")).toHaveAttribute("data-pulse", "true");
    // Both connections of the faulted device, and nothing moves on them.
    for (const id of ["line-plc-m1", "line-m1-m2"]) {
      expect(screen.getByTestId(id)).toHaveAttribute("data-tone", "fault");
      expect(screen.getByTestId(id)).toHaveAttribute("data-animated", "false");
    }
    expect(shown("M-02")).toHaveAttribute("data-tone", "run");

    FakeEventSource.current.send(
      devices([live("PLC-01", "RUNNING"), live("M-01", "RUNNING"), live("M-02", "RUNNING")]),
    );
    expect(shown("M-01")).toHaveAttribute("data-tone", "run");
    expect(screen.getByTestId("line-m1-m2")).toHaveAttribute("data-tone", "active");
  });

  it("shows a PLC that does not answer as such, and stops the flow on its connections", () => {
    setup(CONNECTED);
    FakeEventSource.current.open();
    FakeEventSource.current.send(
      snapshot([
        live("PLC-01", "RUNNING", { source: "STORED", quality: "DISCONNECTED" }),
        live("M-01", "RUNNING"),
        live("M-02", "RUNNING"),
      ]),
    );
    expect(shown("PLC-01")).toHaveAttribute("data-tone", "disc");
    expect(shown("PLC-01")).toHaveTextContent("No answer");
    expect(screen.getByTestId("line-plc-m1")).toHaveAttribute("data-tone", "idle");
    expect(screen.getByTestId("line-m1-m2")).toHaveAttribute("data-tone", "active");
  });

  it("falls back to stale when the stream is interrupted, keeping a fault visible", () => {
    setup(CONNECTED);
    FakeEventSource.current.open();
    FakeEventSource.current.send(
      snapshot([live("PLC-01", "RUNNING"), live("M-01", "FAULTED"), live("M-02", "RUNNING")]),
    );
    FakeEventSource.current.drop();
    expect(screen.getByRole("status", { name: "Live state" })).toHaveTextContent("state · reconnecting");
    expect(shown("PLC-01")).toHaveAttribute("data-tone", "deg");
    expect(shown("M-02")).toHaveTextContent("Running · stale");
    // The last thing known about M-01 is a fault: it stays red, but nothing pulses or flows.
    expect(shown("M-01")).toHaveAttribute("data-tone", "flt");
    expect(shown("M-01")).toHaveAttribute("data-pulse", "false");
    expect(screen.getByTestId("line-plc-m1")).toHaveAttribute("data-tone", "fault");
    expect(screen.getByTestId("line-m1-m2")).toHaveAttribute("data-animated", "false");

    FakeEventSource.current.open();
    expect(shown("PLC-01")).toHaveAttribute("data-tone", "run");
  });

  it("lists the stored conductors of a selected device, and names a relationship that has none", () => {
    const wired: FactorySceneView = {
      ...CONNECTED,
      connections: [
        ...CONNECTED.connections,
        {
          id: "cable",
          relationship: "WIRED_TO",
          sourceId: "id-M-01",
          targetId: "id-M-02",
          line: "signal",
          label: "wired to · 3 wires",
          conductors: ["U", "V", "W"].map((phase) => ({
            id: `wire-${phase}`,
            kind: "POWER" as const,
            from: `M-01 / ${phase}`,
            to: `M-02 / ${phase}`,
          })),
        },
      ],
    };
    const { inspector } = setup(wired);
    fireEvent.click(inspector.getByRole("button", { name: /M-01/ }));

    const list = within(inspector.getByRole("list", { name: "Connections of M-01" }));
    expect(list.getByText("M-02 · wired to · 3 wires")).toBeInTheDocument();
    expect(list.getByText("3 conductors · U → U, V → V, W → W")).toBeInTheDocument();
    expect(list.getByText("M-02 · drives")).toBeInTheDocument();
    expect(list.getAllByText("relationship, no conductor")).toHaveLength(2);
  });
});
