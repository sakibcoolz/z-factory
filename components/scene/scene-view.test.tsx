import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorySceneView, SceneDeviceView } from "@/lib/domain/scene-view";
import type { OperationState } from "@/lib/plc/operation-state";
import { SceneView } from "./scene-view";

/** Stands in for the WebGL canvas: shows what it was given and lets a test pick a device in it. */
vi.mock("next/dynamic", () => ({
  default: () =>
    function CanvasStub(props: {
      scene: FactorySceneView;
      selectedId: string | null;
      camera: string;
      onSelect: (id: string | null) => void;
    }) {
      return (
        <div data-testid="canvas" data-selected={props.selectedId ?? ""} data-camera={props.camera}>
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
      transformAction={action}
      plcLinks={{ "id-PLC-01": "/factories/factory-1/plcs/id-PLC-01" }}
      designerHref="/factories/factory-1/designer"
    />,
  );
  const submitted = () =>
    action.mock.calls.map(([, formData]) => [formData.get("deviceId"), formData.get("operation")]);
  return { action, submitted, inspector: within(screen.getByRole("complementary", { name: "Scene" })) };
}

const getContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => {
  // jsdom has no WebGL; most tests are about a browser that has it.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as typeof getContext;
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = getContext;
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
    expect(inspector.getByText("Running")).toBeInTheDocument();

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
});
