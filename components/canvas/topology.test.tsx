import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TopologyEdgeView, TopologyNodeView } from "@/lib/domain/topology-view";
import { edgeLabel, edgeLine, edgesOf, edgeTone, hasActivity, nodeKind } from "@/lib/topology/flow";
import { DevicePalette, PALETTE_MIME } from "./device-palette";
import { type CanvasActions, TopologyCanvas } from "./topology-canvas";
import { TopologyInspector } from "./topology-inspector";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

// React Flow measures its container and nodes; jsdom has no layout.
beforeAll(() => {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
    },
  );
});

const node = (overrides: Partial<TopologyNodeView>): TopologyNodeView => ({
  id: "plc",
  name: "PLC-01",
  role: "Pump station",
  categoryCode: "PLC",
  categoryName: "PLC / programmable controller",
  manufacturer: "Siemens",
  modelName: "CPU 1214C DC/DC/DC",
  architectureType: "COMPACT",
  runtimeStatus: "STOPPED",
  x: 0,
  y: 0,
  placed: true,
  ...overrides,
});

const nodes: TopologyNodeView[] = [
  node({}),
  node({
    id: "valve",
    name: "XV-101",
    role: null,
    categoryCode: "VALVE",
    categoryName: "Valve",
    manufacturer: "Generic / simulated",
    modelName: "Generic on/off valve, 24 V DC",
    architectureType: null,
    x: 300,
  }),
  node({
    id: "vfd",
    name: "VFD-01",
    role: null,
    categoryCode: "VFD",
    categoryName: "Variable-frequency drive",
    modelName: "Generic VFD, Modbus TCP",
    architectureType: null,
    x: 300,
    y: 200,
  }),
];

const edges: TopologyEdgeView[] = [
  {
    id: "plc|valve|CONTROLS",
    relationship: "CONTROLS",
    sourceId: "plc",
    targetId: "valve",
    wires: [{ terminalLabel: "Y1", pointLabel: "DO Qa.0", logicalAddress: "%QX0.0", tagName: "XV_101_Y1" }],
    protocol: null,
  },
  {
    id: "plc|vfd|COMMUNICATES_WITH",
    relationship: "COMMUNICATES_WITH",
    sourceId: "plc",
    targetId: "vfd",
    wires: [],
    protocol: "MODBUS_TCP",
  },
];

const ok = async () => ({ ok: true as const, value: undefined });
const actions = (overrides: Partial<CanvasActions> = {}): CanvasActions => ({
  place: vi.fn(async () => ({ ok: true as const, value: { id: "new", name: "FAN-01" } })),
  move: vi.fn(ok),
  link: vi.fn(async () => ({ ok: true as const, value: { status: "LINKED" as const } })),
  unlink: vi.fn(ok),
  remove: vi.fn(ok),
  rename: vi.fn(ok),
  ...overrides,
});

describe("canvas mapping", () => {
  it("draws each relationship with its own line and label", () => {
    expect(["CONTROLS", "DRIVES", "MECHANICALLY_DRIVES"].map((r) => edgeLine(r as never))).toEqual([
      "signal",
      "signal",
      "signal",
    ]);
    expect(edgeLine("COMMUNICATES_WITH")).toBe("network");
    expect(["FEEDS_BACK_TO", "MEASURES"].map((r) => edgeLine(r as never))).toEqual(["feedback", "feedback"]);
    expect(edges.map(edgeLabel)).toEqual(["controls · 1 wire", "communicates with · Modbus TCP"]);
    expect(edgeLabel({ relationship: "DRIVES", wires: [], protocol: null })).toBe("drives");
  });

  it("lays runtime state over edges: a fault wins, activity needs both ends running", () => {
    expect(edgeTone("RUNNING", "RUNNING")).toBe("active");
    expect(edgeTone("RUNNING", "STOPPED")).toBe("idle");
    expect(edgeTone("RUNNING", "FAULTED")).toBe("fault");
    expect(edgeTone(undefined, undefined)).toBe("idle");
    expect(hasActivity(nodes)).toBe(false);
    expect(hasActivity([...nodes, node({ runtimeStatus: "DEGRADED" })])).toBe(true);
  });

  it("names what a node is and finds its edges", () => {
    expect(nodes.map(nodeKind)).toEqual(["PLC · compact", "Valve", "Variable-frequency drive"]);
    expect(edgesOf("valve", edges).map((edge) => edge.id)).toEqual(["plc|valve|CONTROLS"]);
    expect(edgesOf("plc", edges)).toHaveLength(2);
  });
});

describe("device palette", () => {
  const groups = [
    {
      categoryCode: "PLC",
      categoryName: "PLC / programmable controller",
      items: [
        {
          modelId: "m-plc",
          modelName: "CPU 1214C DC/DC/DC",
          manufacturer: "Siemens",
          architectureType: "COMPACT" as const,
        },
      ],
    },
    {
      categoryCode: "FAN",
      categoryName: "Fan",
      items: [
        { modelId: "m-fan", modelName: "Generic fan", manufacturer: "Generic / simulated", architectureType: null },
      ],
    },
  ];

  it("lists catalog models by category and creates a device from the add button", async () => {
    const onPlace = vi.fn(async () => ({ ok: true as const, value: { id: "d1", name: "FAN-01" } }));
    render(<DevicePalette groups={groups} onPlace={onPlace} deviceCount={2} />);

    expect(screen.getByText("PLC")).toBeInTheDocument();
    expect(screen.getByText("CPU 1214C DC/DC/DC")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Generic fan" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Added FAN-01"));
    expect(onPlace).toHaveBeenCalledWith({ deviceModelId: "m-fan", x: 160, y: 160 });
    expect(refresh).toHaveBeenCalled();
  });

  it("carries the catalog model id when an item is dragged, and shows a refusal", async () => {
    const onPlace = vi.fn(async () => ({ ok: false as const, message: "The catalog model does not exist." }));
    render(<DevicePalette groups={groups} onPlace={onPlace} deviceCount={0} />);

    const setData = vi.fn();
    fireEvent.dragStart(screen.getByText("Generic fan").closest("li") as HTMLElement, {
      dataTransfer: { setData, effectAllowed: "" },
    });
    expect(setData).toHaveBeenCalledWith(PALETTE_MIME, "m-fan");

    fireEvent.click(screen.getByRole("button", { name: "Add Generic fan" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The catalog model does not exist."));
  });
});

describe("topology inspector", () => {
  const base = {
    nodes,
    edges,
    readOnly: false,
    busy: false,
    plcLinks: { plc: "/factories/f/plcs/plc" },
    onRename: vi.fn(),
    onRemoveDevice: vi.fn(),
    onRemoveEdge: vi.fn(),
  };

  it("explains how to use the canvas when nothing is selected", () => {
    render(<TopologyInspector {...base} selection={undefined} />);
    expect(screen.getByText(/Drag a model from the palette/)).toBeInTheDocument();
  });

  it("shows a device with its typed connections and lets it be renamed", () => {
    const onRename = vi.fn();
    render(<TopologyInspector {...base} onRename={onRename} selection={{ kind: "node", id: "plc" }} />);

    expect(screen.getByText("PLC · compact")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open PLC" })).toHaveAttribute("href", "/factories/f/plcs/plc");
    expect(screen.getByText("Connections (2)")).toBeInTheDocument();
    expect(screen.getByText("PLC-01 controls · 1 wire XV-101")).toBeInTheDocument();
    expect(screen.getByText("PLC-01 communicates with · Modbus TCP VFD-01")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PLC-A" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "Line 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name and role" }));
    expect(onRename).toHaveBeenCalledWith("plc", { name: "PLC-A", role: "Line 2" });
  });

  it("deletes a device only after confirmation", () => {
    const onRemoveDevice = vi.fn();
    render(<TopologyInspector {...base} onRemoveDevice={onRemoveDevice} selection={{ kind: "node", id: "valve" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete device" }));
    expect(onRemoveDevice).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Delete XV-101 and its connections?");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete device" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(onRemoveDevice).toHaveBeenCalledWith("valve");
  });

  it("shows a wired connection with its channels and removes it", () => {
    const onRemoveEdge = vi.fn();
    render(
      <TopologyInspector
        {...base}
        onRemoveEdge={onRemoveEdge}
        selection={{ kind: "edge", id: "plc|valve|CONTROLS" }}
      />,
    );

    expect(screen.getByText("controls")).toBeInTheDocument();
    expect(screen.getByText("Y1 → DO Qa.0 · %QX0.0")).toBeInTheDocument();
    expect(screen.getByText(/disconnects the device from the PLC/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    expect(onRemoveEdge).toHaveBeenCalledWith(edges[0]);
  });

  it("offers no edits in the read-only topology view", () => {
    render(<TopologyInspector {...base} readOnly selection={{ kind: "node", id: "valve" }} />);
    expect(screen.getByText("XV-101")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
});

describe("topology canvas", () => {
  it("shows every device with its unique instance name and each typed connection", () => {
    render(<TopologyCanvas view={{ nodes, edges }} plcLinks={{}} actions={actions()} />);

    for (const name of ["PLC-01", "XV-101", "VFD-01"]) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByText("Generic on/off valve, 24 V DC")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeInTheDocument();
  });

  it("opens a device in the inspector when its node is clicked", () => {
    render(<TopologyCanvas view={{ nodes, edges }} plcLinks={{ plc: "/plc" }} actions={actions()} />);
    fireEvent.click(screen.getByText("XV-101"));
    const inspector = within(screen.getByRole("complementary", { name: "Inspector" }));
    expect(inspector.getByText("Connections (1)")).toBeInTheDocument();
    expect(inspector.getByLabelText("Name")).toHaveValue("XV-101");
  });

  it("creates a device where a palette item is dropped and reports a refusal", async () => {
    const place = vi.fn(async () => ({
      ok: false as const,
      message: "A device with this name already exists in this factory.",
    }));
    render(<TopologyCanvas view={{ nodes, edges }} plcLinks={{}} actions={actions({ place })} />);

    const canvas = document.querySelector(".zf-flow") as HTMLElement;
    fireEvent.drop(canvas, {
      clientX: 120,
      clientY: 90,
      dataTransfer: { getData: (type: string) => (type === PALETTE_MIME ? "m-fan" : "") },
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("already exists"));
    expect(place).toHaveBeenCalledWith(expect.objectContaining({ deviceModelId: "m-fan" }));

    // Something else dropped on the canvas is ignored.
    fireEvent.drop(canvas, { clientX: 1, clientY: 1, dataTransfer: { getData: () => "" } });
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("is read-only without actions: nothing can be dropped or edited", () => {
    render(<TopologyCanvas view={{ nodes, edges }} plcLinks={{}} />);
    fireEvent.drop(document.querySelector(".zf-flow") as HTMLElement, { dataTransfer: { getData: () => "m-fan" } });
    fireEvent.click(screen.getByText("PLC-01"));
    expect(screen.queryByRole("button", { name: "Delete device" })).not.toBeInTheDocument();
    // The inspector still shows what was selected.
    expect(
      within(screen.getByRole("complementary", { name: "Inspector" })).getByText("Connections (2)"),
    ).toBeInTheDocument();
  });
});
