import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CommunicationLinkView, LinkTagOption, PlcCommunicationView } from "@/lib/domain/plc-communication-view";
import { type CommunicationActions, PlcCommunication } from "./plc-communication";

const noop = async () => ({});
const actions: CommunicationActions = {
  create: noop,
  link: () => noop,
  addMapping: () => noop,
  mapping: () => noop,
  linkFile: (linkId) => `/f/p/communication/${linkId}/link.json`,
  peerHref: (plcId) => `/f/plcs/${plcId}/communication`,
};

const option = (name: string, refusal: string | null = null, extra: Partial<LinkTagOption> = {}): LinkTagOption => ({
  tagId: name,
  name,
  logicalAddress: "%MW10",
  dataType: "INT16",
  unit: null,
  scale: 1,
  refusal,
  ...extra,
});

const entry = (overrides: Partial<CommunicationLinkView> = {}): CommunicationLinkView => ({
  link: {
    id: "l1",
    factoryId: "f",
    relationship: "SUPERVISES",
    protocol: "MODBUS_TCP",
    source: { plcId: "a", name: "PLC-A", runtimeStatus: "RUNNING" },
    target: { plcId: "b", name: "PLC-B", runtimeStatus: "RUNNING" },
    client: "SOURCE",
    clientPlcId: "a",
    serverPlcId: "b",
    serverHost: "plc-b",
    serverPort: 502,
    unitId: 1,
    pollIntervalMs: 500,
    enabled: true,
    configVersion: 3,
    mappingCount: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  },
  role: "client",
  peer: { plcId: "b", name: "PLC-B" },
  health: { quality: "DISCONNECTED", reason: "PLC-B does not answer on Modbus.", since: "x", checkedAt: "y" },
  deployedVersion: 2,
  mappings: [
    {
      id: "m1",
      linkId: "l1",
      operation: "WRITE",
      localTag: {
        tagId: "t1",
        name: "Start_B",
        logicalAddress: "%QX101.0",
        area: "COIL",
        address: 808,
        dataType: "BOOL",
        unit: null,
        scale: 1,
      },
      remoteTag: {
        tagId: "t2",
        name: "Start_Cmd",
        logicalAddress: "%QX100.0",
        area: "COIL",
        address: 800,
        dataType: "BOOL",
        unit: null,
        scale: 1,
      },
      updateIntervalMs: null,
      effectiveIntervalMs: 500,
      enabled: true,
      quality: "DISCONNECTED",
    },
  ],
  options: {
    READ: {
      local: [option("B_Temp"), option("Gw_Cmd", "external command: a link fills free %I or %M only")],
      remote: [option("Temperature")],
    },
    WRITE: {
      local: [option("Start_B", null, { dataType: "BOOL" })],
      remote: [option("Running", "program output: only a command or setpoint is written")],
    },
  },
  ...overrides,
});

const view = (links: CommunicationLinkView[]): PlcCommunicationView => ({
  plcId: "a",
  factoryId: "f",
  peers: [
    { plcId: "b", name: "PLC-B", runtimeStatus: "RUNNING", servesModbus: true },
    { plcId: "c", name: "RTU-01", runtimeStatus: "STOPPED", servesModbus: false },
  ],
  links,
  watched: true,
});

describe("PLC communication screen", () => {
  it("traces each value from this PLC's tag over the link to the peer's register, with its quality", () => {
    render(<PlcCommunication view={view([entry()])} plc={{ name: "PLC-A" }} actions={actions} />);
    const link = within(screen.getByRole("region", { name: "Link to PLC-B" }));
    expect(link.getByText("PLC-A supervises PLC-B")).toBeInTheDocument();
    expect(link.getByText("this PLC is the client")).toBeInTheDocument();
    expect(
      link.getByText(/PLC-A \(client\) → Modbus TCP plc-b:502 unit 1 → PLC-B \(server\) · every 500 ms · version 3/),
    ).toBeInTheDocument();
    // Not yet deployed with the latest version: said, and the reason the link is down.
    expect(
      link.getByText(/PLC-A runs version 2; deploy its program to apply version 3\. PLC-B does not answer on Modbus\./),
    ).toBeInTheDocument();
    const values = within(link.getByRole("table", { name: "Values on the link to PLC-B" }));
    expect(values.getByText("WRITE → PLC-B command")).toBeInTheDocument();
    expect(values.getByText("Start_B · %QX101.0")).toBeInTheDocument();
    expect(values.getAllByText("disconnected").length).toBeGreaterThan(0);
    expect(link.getByText(/the server's program decides|PLC-B's program decides/)).toBeInTheDocument();
    expect(link.getByRole("link", { name: "Link and values (JSON)" })).toHaveAttribute(
      "href",
      "/f/p/communication/l1/link.json",
    );
  });

  it("offers usable tags per direction and lists the others disabled with the reason", () => {
    render(<PlcCommunication view={view([entry()])} plc={{ name: "PLC-A" }} actions={actions} />);
    const local = screen.getByRole("combobox", { name: "Into this PLC's tag" }) as HTMLSelectElement;
    expect([...local.options].map((item) => [item.disabled, item.textContent])).toEqual([
      [false, "B_Temp · %MW10 · INT16"],
      [true, "Gw_Cmd · %MW10 · INT16 — external command: a link fills free %I or %M only"],
    ]);
    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "WRITE" } });
    const remote = screen.getByRole("combobox", { name: "To PLC-B's command or setpoint" }) as HTMLSelectElement;
    expect([...remote.options].map((item) => [item.disabled, item.textContent])).toEqual([
      [false, "no possible tag"],
      [true, "Running · %MW10 · INT16 — program output: only a command or setpoint is written"],
    ]);
  });

  it("shows the server side read-only, and offers new links to the factory's other PLCs", () => {
    render(
      <PlcCommunication
        view={view([entry({ role: "server", options: null, health: null, deployedVersion: 3 })])}
        plc={{ name: "PLC-B" }}
        actions={actions}
      />,
    );
    expect(screen.getByText("this PLC is the server")).toBeInTheDocument();
    expect(screen.getByText("The values of this link are configured on PLC-A, its client.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /New value/ })).not.toBeInTheDocument();
    expect(screen.getByText(/The link's health is shown while the factory runs/)).toBeInTheDocument();
    const peer = screen.getByLabelText("Link to") as HTMLSelectElement;
    expect([...peer.options].map((item) => item.textContent)).toEqual(["PLC-B", "RTU-01 (does not serve Modbus TCP)"]);
  });
});
