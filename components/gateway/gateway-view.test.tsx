import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GatewayConnectionView, GatewaysView } from "@/lib/domain/gateway-view";
import { type GatewayActions, GatewaysScreen } from "./gateway-view";

const noop = async () => ({});
const actions: GatewayActions = {
  add: noop,
  connect: () => noop,
  connection: () => noop,
  mapTag: () => noop,
  mapHref: (connectionId) => `/factories/f/gateways/${connectionId}/map.json`,
};

const connection = (overrides: Partial<GatewayConnectionView> = {}): GatewayConnectionView => ({
  id: "c1",
  plcId: "p1",
  plcName: "PLC-01",
  plcState: "RUNNING",
  host: "192.168.0.103",
  port: 15020,
  unitId: 1,
  pollIntervalMs: 1000,
  enabled: true,
  endpoint: {
    listening: true,
    error: null,
    clients: 1,
    requests: 42,
    refused: 3,
    lastRequestAt: "2026-10-05T11:22:33.000Z",
  },
  registers: [
    {
      mappingId: "m1",
      tagId: "t1",
      tagName: "Start_Cmd",
      externalName: "pump.start",
      role: "COMMAND",
      dataType: "BOOL",
      area: "COIL",
      address: 80,
      displayAddress: "00081",
      wordCount: 1,
      access: "READ_WRITE",
      unit: null,
    },
    {
      mappingId: "m2",
      tagId: "t2",
      tagName: "Flow_Total",
      externalName: "Flow_Total",
      role: "PROCESS_VALUE",
      dataType: "FLOAT32",
      area: "HOLDING_REGISTER",
      address: 2048,
      displayAddress: "42049",
      wordCount: 2,
      access: "READ",
      unit: "m3",
    },
  ],
  unmappedTags: [
    { id: "t3", name: "Running", role: "FEEDBACK", dataType: "BOOL", writable: false },
    { id: "t4", name: "Speed_SP", role: "SETPOINT", dataType: "INT16", writable: true },
  ],
  ...overrides,
});

const view = (overrides: Partial<GatewaysView> = {}): GatewaysView => ({
  factory: { id: "f", name: "Line" },
  bindAddresses: ["127.0.0.1", "192.168.0.103"],
  portRange: { min: 15000, max: 15999 },
  suggestedPort: 15021,
  hasPlc: true,
  gateways: [
    {
      deviceId: "g1",
      name: "GATEWAY-01",
      modelName: "Generic Modbus TCP gateway",
      connections: [connection()],
      availablePlcs: [{ id: "p2", name: "PLC-02" }],
    },
  ],
  ...overrides,
});

describe("gateways screen", () => {
  it("shows where a gateway connects, what it is given and what it may write", () => {
    render(<GatewaysScreen view={view()} actions={actions} />);
    const gateway = screen.getByRole("article", { name: "GATEWAY-01" });
    expect(within(gateway).getByText("192.168.0.103:15020")).toBeInTheDocument();
    expect(within(gateway).getByText("unit 1 · read every 1000 ms")).toBeInTheDocument();
    expect(within(gateway).getByText("open · 1 device connected")).toBeInTheDocument();
    expect(within(gateway).getByText(/42 requests · 3 refused · last at 11:22:33 UTC/)).toBeInTheDocument();
    expect(within(gateway).getByRole("link", { name: "Register map for the gateway (JSON)" })).toHaveAttribute(
      "href",
      "/factories/f/gateways/c1/map.json",
    );

    const rows = within(gateway)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(rows.map((cells) => cells.slice(0, 6))).toEqual([
      ["pump.start", "Start_Cmd", "command", "BOOL", "coil 80 · 00081", "read and write"],
      ["Flow_Total", "Flow_Total", "process value", "FLOAT32", "holding register 2048 · 42049 · 2 words", "read"],
    ]);

    // A tag that PLC logic produces is offered for reading only.
    const options = within(within(gateway).getByLabelText("Tag"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Running · feedback · read only", "Speed_SP · setpoint"]);
    // A PLC it is not connected to yet can be connected on an address the host allows.
    expect(within(gateway).getByRole("form", { name: "Connect GATEWAY-01 to a PLC" })).toBeInTheDocument();
    expect(
      within(within(gateway).getByLabelText("Address of this host"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["127.0.0.1 · this machine only", "192.168.0.103"]);
    expect(within(gateway).getByLabelText("Port · 15000–15999")).toHaveValue(15021);
    // The control rule is on the screen, and no control writes a tag.
    expect(screen.getByText(/writes only command and setpoint tags/)).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("says why an endpoint is not open, and when nothing outside this machine can connect", () => {
    const failed = connection({
      endpoint: {
        listening: false,
        error: "The port is in use by another program on this host.",
        clients: 0,
        requests: 0,
        refused: 0,
        lastRequestAt: null,
      },
      registers: [],
      unmappedTags: [],
    });
    const closed = connection({
      id: "c2",
      plcName: "PLC-02",
      enabled: false,
      endpoint: { ...failed.endpoint, error: null },
    });
    render(
      <GatewaysScreen
        view={view({
          bindAddresses: ["127.0.0.1"],
          gateways: [
            {
              deviceId: "g1",
              name: "GATEWAY-01",
              modelName: "Generic",
              connections: [failed, closed],
              availablePlcs: [],
            },
          ],
        })}
        actions={actions}
      />,
    );
    expect(screen.getByText("not open")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The port is in use by another program on this host.");
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open endpoint" })).toBeInTheDocument();
    expect(screen.getAllByText(/No tag is mapped yet/)).toHaveLength(1);
    expect(screen.getByRole("note")).toHaveTextContent("RUNTIME_BIND_ADDRESSES");
    expect(screen.queryByRole("form", { name: /Connect GATEWAY-01/ })).not.toBeInTheDocument();
  });

  it("explains an empty factory", () => {
    render(<GatewaysScreen view={view({ gateways: [], hasPlc: false })} actions={actions} />);
    expect(screen.getByText(/No gateway yet/)).toBeInTheDocument();
    expect(screen.getByText(/This factory has no PLC yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add gateway" })).toBeInTheDocument();
  });
});
