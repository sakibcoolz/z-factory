import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type WiringActions, WiringEditor } from "@/components/canvas/wiring-editor";
import type { PairWiringView, WireView, WiringEndpointView } from "@/lib/domain/wiring-view";

const endpoint = (
  type: WiringEndpointView["type"],
  id: string,
  label: string,
  summary: string,
  overrides: Partial<WiringEndpointView> = {},
): WiringEndpointView => ({
  key: `${type}:${id}`,
  type,
  id,
  label,
  kind: "SIGNAL",
  summary,
  maxConnections: 1,
  wires: [],
  ...overrides,
});

const wire: WireView = {
  id: "wire-1",
  kind: "SIGNAL",
  from: {
    deviceId: "pt",
    deviceName: "PT-101",
    type: "DEVICE_IO",
    endpointId: "out",
    label: "OUT",
    name: "PT-101 / OUT",
  },
  to: {
    deviceId: "plc",
    deviceName: "PLC-01",
    type: "PLC_IO_POINT",
    endpointId: "ai0",
    label: "AI 0",
    name: "PLC-01 / AI 0",
  },
  tagName: "PT_101_OUT",
  logicalAddress: "%MW0",
};

const REFUSED_DI = "PT-101 / OUT is analog and PLC-01 / DI Ia.0 is digital.";
const REFUSED_SUPPLY =
  "PT-101 / +24V is a supply terminal and PLC-01 / AI 0 is a signal terminal; only endpoints of the same kind are wired together.";

/** A transmitter and a PLC: OUT fits the analog inputs only; the supply terminal fits nothing on the PLC. */
const pair = (overrides: Partial<PairWiringView> = {}): PairWiringView => ({
  first: {
    deviceId: "pt",
    name: "PT-101",
    endpoints: [
      endpoint("DEVICE_IO", "out", "OUT", "analog output · 0–10 V"),
      endpoint("DEVICE_IO", "v24", "+24V", "supply input · 24 V DC", { kind: "POWER" }),
    ],
  },
  second: {
    deviceId: "plc",
    name: "PLC-01",
    endpoints: [
      endpoint("PLC_IO_POINT", "di0", "DI Ia.0", "digital input · 24 V DC"),
      endpoint("PLC_IO_POINT", "ai0", "AI 0", "analog input · 0–10 V"),
      endpoint("PLC_IO_POINT", "ai1", "AI 1", "analog input · 0–10 V"),
    ],
  },
  wires: [],
  refusals: {
    "DEVICE_IO:out": { "PLC_IO_POINT:di0": REFUSED_DI },
    "DEVICE_IO:v24": {
      "PLC_IO_POINT:di0": REFUSED_SUPPLY,
      "PLC_IO_POINT:ai0": REFUSED_SUPPLY,
      "PLC_IO_POINT:ai1": REFUSED_SUPPLY,
    },
  },
  replacingWireId: null,
  ...overrides,
});

const ok = <T,>(value: T) => ({ ok: true as const, value });

function setup(view: PairWiringView | (() => PairWiringView), overrides: Partial<WiringActions> = {}) {
  const actions: WiringActions = {
    load: vi.fn(async () => ok(typeof view === "function" ? view() : view)),
    connect: vi.fn(async () => ok({ wireId: "wire-2" })),
    reconnect: vi.fn(async () => ok({ wireId: "wire-3" })),
    disconnect: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
  const onChanged = vi.fn();
  render(<WiringEditor firstId="pt" secondId="plc" actions={actions} onChanged={onChanged} />);
  return { actions, onChanged };
}

const options = (label: string) =>
  within(screen.getByLabelText(label))
    .getAllByRole("option")
    .map((option) => option.textContent);

describe("wiring editor", () => {
  it("lists the endpoints of both devices and suggests the first wire that is possible", async () => {
    setup(pair());

    expect(
      await screen.findByText("No wire between these two devices yet. Connecting them wires nothing by itself."),
    ).toBeInTheDocument();
    expect(options("PT-101 endpoint")).toEqual(["OUT · analog output · 0–10 V", "+24V · supply input · 24 V DC"]);
    // A destination the rules refuse is marked before anything is saved.
    expect(options("PLC-01 endpoint")).toEqual([
      "DI Ia.0 · digital input · 24 V DC · not possible",
      "AI 0 · analog input · 0–10 V",
      "AI 1 · analog input · 0–10 V",
    ]);
    expect(screen.getByLabelText("PT-101 endpoint")).toHaveValue("DEVICE_IO:out");
    expect(screen.getByLabelText("PLC-01 endpoint")).toHaveValue("PLC_IO_POINT:ai0");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add wire" })).toBeEnabled();
  });

  it("saves one wire between the two chosen endpoints", async () => {
    const { actions, onChanged } = setup(pair());
    await screen.findByLabelText("PLC-01 endpoint");

    fireEvent.change(screen.getByLabelText("PLC-01 endpoint"), { target: { value: "PLC_IO_POINT:ai1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add wire" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(actions.connect).toHaveBeenCalledWith({
      from: { deviceId: "pt", type: "DEVICE_IO", id: "out" },
      to: { deviceId: "plc", type: "PLC_IO_POINT", id: "ai1" },
    });
    // The wiring is read again after the change.
    expect(actions.load).toHaveBeenCalledTimes(2);
  });

  it("blocks a destination the rules refuse, naming both endpoints and the reason", async () => {
    const { actions } = setup(pair());
    await screen.findByLabelText("PLC-01 endpoint");

    fireEvent.change(screen.getByLabelText("PLC-01 endpoint"), { target: { value: "PLC_IO_POINT:di0" } });

    expect(screen.getByRole("alert")).toHaveTextContent(REFUSED_DI);
    expect(screen.getByRole("button", { name: "Add wire" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Add wire" }));
    expect(actions.connect).not.toHaveBeenCalled();

    // An endpoint with nowhere to go on the other device says so for every destination.
    fireEvent.change(screen.getByLabelText("PT-101 endpoint"), { target: { value: "DEVICE_IO:v24" } });
    expect(screen.getByRole("alert")).toHaveTextContent(REFUSED_SUPPLY);
    expect(options("PLC-01 endpoint").every((text) => text?.endsWith("not possible"))).toBe(true);
  });

  it("shows what the server refuses and keeps the choice", async () => {
    const message = "PLC-01 / AI 0 already has its wire, to PT-102 / OUT.";
    const { onChanged } = setup(pair(), { connect: vi.fn(async () => ({ ok: false as const, message })) });
    await screen.findByLabelText("PLC-01 endpoint");

    fireEvent.click(screen.getByRole("button", { name: "Add wire" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByLabelText("PLC-01 endpoint")).toHaveValue("PLC_IO_POINT:ai0");
  });

  it("lists the wires with their address and tag, and removes one", async () => {
    const { actions, onChanged } = setup(pair({ wires: [wire] }));

    expect(await screen.findByText("PT-101 / OUT → PLC-01 / AI 0")).toBeInTheDocument();
    expect(screen.getByText("%MW0 · PT_101_OUT")).toBeInTheDocument();
    expect(screen.getByText("Wires · 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove the wire PT-101 / OUT → PLC-01 / AI 0" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(actions.disconnect).toHaveBeenCalledWith("wire-1");
  });

  it("moves a wire: it starts from where the wire is and replaces it in one step", async () => {
    const { actions, onChanged } = setup(pair({ wires: [wire] }));
    await screen.findByText("PT-101 / OUT → PLC-01 / AI 0");

    fireEvent.click(screen.getByRole("button", { name: "Move the wire PT-101 / OUT → PLC-01 / AI 0" }));

    // The endpoints are asked for again with the wire named, so its own ends count as free.
    await waitFor(() => expect(actions.load).toHaveBeenLastCalledWith("pt", "plc", "wire-1"));
    expect(await screen.findByText("Move PT-101 / OUT → PLC-01 / AI 0")).toBeInTheDocument();
    expect(screen.getByLabelText("PT-101 endpoint")).toHaveValue("DEVICE_IO:out");
    expect(screen.getByLabelText("PLC-01 endpoint")).toHaveValue("PLC_IO_POINT:ai0");

    fireEvent.change(screen.getByLabelText("PLC-01 endpoint"), { target: { value: "PLC_IO_POINT:ai1" } });
    fireEvent.click(screen.getByRole("button", { name: "Move wire" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(actions.reconnect).toHaveBeenCalledWith("wire-1", {
      from: { deviceId: "pt", type: "DEVICE_IO", id: "out" },
      to: { deviceId: "plc", type: "PLC_IO_POINT", id: "ai1" },
    });
    expect(actions.connect).not.toHaveBeenCalled();
  });

  it("leaves a wire alone when moving it is given up", async () => {
    const { actions } = setup(pair({ wires: [wire] }));
    await screen.findByText("PT-101 / OUT → PLC-01 / AI 0");

    fireEvent.click(screen.getByRole("button", { name: "Move the wire PT-101 / OUT → PLC-01 / AI 0" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep it where it is" }));

    expect(await screen.findByText("Add a wire")).toBeInTheDocument();
    expect(actions.reconnect).not.toHaveBeenCalled();
    expect(actions.disconnect).not.toHaveBeenCalled();
  });

  it("says when a device has nothing to wire, and when the endpoints cannot be read", async () => {
    const empty = pair();
    setup({ ...empty, second: { ...empty.second, name: "P-101", endpoints: [] } });
    expect(await screen.findByText("P-101 has no terminal to wire.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add wire" })).not.toBeInTheDocument();
  });

  it("says when nothing more can be wired between the two devices", async () => {
    const view = pair();
    const all = Object.fromEntries(
      view.second.endpoints.map((item) => [item.key, "PT-101 / OUT already has its wire."]),
    );
    setup({ ...view, refusals: { ...view.refusals, "DEVICE_IO:out": all } });

    expect(await screen.findByText(/Nothing more can be wired between these two as they are/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add wire" })).toBeDisabled();
  });

  it("shows why the endpoints could not be read", async () => {
    setup(pair(), { load: vi.fn(async () => ({ ok: false as const, message: "The device does not exist." })) });
    expect(await screen.findByRole("alert")).toHaveTextContent("The device does not exist.");
  });
});
