import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeviceTree } from "@/components/factories/device-tree";
import type { DeviceTreeNode } from "@/lib/domain/device-tree";
import type { FactoryDeviceView } from "@/lib/domain/plc-config-view";
import type { RuntimeState } from "@/lib/domain/runtime-state";

const FACTORY_ID = "01a107ff-de99-71ec-adbb-40049a4cf552";

type Node = DeviceTreeNode<FactoryDeviceView>;

const node = (
  name: string,
  categoryName: string,
  children: Node[] = [],
  runtimeStatus: RuntimeState = "STOPPED",
): Node => ({
  device: {
    id: `id-${name}`,
    name,
    role: null,
    modelName: `Generic ${categoryName}`,
    manufacturer: "Generic / simulated",
    categoryCode: categoryName.toUpperCase(),
    categoryName,
    architectureType: categoryName === "PLC" ? "COMPACT" : null,
    runtimeStatus,
  },
  children,
});

/** PLC-01 → drive → motor → pump, and a sensor; PLC-02 with a valve; a switch connected to nothing. */
const factory = (pumpState: RuntimeState = "STOPPED"): Node[] => [
  node("PLC-01", "PLC", [
    node("PT-101", "Sensor"),
    node("VFD-01", "Drive", [node("M-01", "Motor", [node("P-01", "Pump", [], pumpState)])]),
  ]),
  node("PLC-02", "PLC", [node("XV-201", "Valve")]),
  node("LS-9", "Switch"),
];

const names = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent);

const toggle = (name: string, action: "Show" | "Hide" = "Show") =>
  screen.getByRole("button", { name: `${action} the devices connected to ${name}` });

describe("factory device hierarchy", () => {
  it("starts with every PLC closed, showing how many devices it holds", () => {
    render(<DeviceTree factoryId={FACTORY_ID} nodes={factory()} />);

    expect(names()).toEqual(["+PLC-014 devices", "+PLC-021 device", "LS-9"]);
    expect(toggle("PLC-01")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("VFD-01")).not.toBeInTheDocument();
    // A device with nothing below it is no drop-down.
    expect(screen.getAllByRole("button", { name: /the devices connected to/ })).toHaveLength(2);
  });

  it("opens one PLC to the devices connected to it, each under the device it is reached through", () => {
    render(<DeviceTree factoryId={FACTORY_ID} nodes={factory()} />);

    fireEvent.click(toggle("PLC-01"));

    expect(names()).toEqual(["−PLC-014 devices", "└PT-101", "└VFD-01", "└M-01", "└P-01", "+PLC-021 device", "LS-9"]);
    expect(toggle("PLC-01", "Hide")).toHaveAttribute("aria-expanded", "true");
    const depth = (name: string) => screen.getByText(name).closest("[data-depth]")?.getAttribute("data-depth");
    expect(["PLC-01", "PT-101", "VFD-01", "M-01", "P-01"].map(depth)).toEqual(["0", "1", "1", "2", "3"]);
    // The other PLC stays closed.
    expect(screen.queryByText("XV-201")).not.toBeInTheDocument();

    fireEvent.click(toggle("PLC-01", "Hide"));
    expect(names()).toEqual(["+PLC-014 devices", "+PLC-021 device", "LS-9"]);
  });

  it("opens and closes every drop-down at once", () => {
    render(<DeviceTree factoryId={FACTORY_ID} nodes={factory()} />);
    const expandAll = screen.getByRole("button", { name: "Expand all" });
    const collapseAll = screen.getByRole("button", { name: "Collapse all" });
    expect(collapseAll).toBeDisabled();

    fireEvent.click(expandAll);
    expect(names()).toHaveLength(8);
    expect(screen.getByText("XV-201")).toBeInTheDocument();
    expect(expandAll).toBeDisabled();

    fireEvent.click(collapseAll);
    expect(names()).toHaveLength(3);
  });

  it("says on a closed PLC that a device below it is faulted", () => {
    render(<DeviceTree factoryId={FACTORY_ID} nodes={factory("FAULTED")} />);

    expect(names()[0]).toBe("+PLC-014 devices · 1 faulted");
    fireEvent.click(toggle("PLC-01"));
    // Opened, the device shows its own state.
    expect(names()[0]).toBe("−PLC-014 devices");
    expect(within(screen.getByText("P-01").closest("tr") as HTMLElement).getByText("Faulted")).toBeInTheDocument();
  });

  it("links every device to its screen and shows type, model and state of every device", () => {
    render(<DeviceTree factoryId={FACTORY_ID} nodes={factory()} />);
    fireEvent.click(toggle("PLC-02"));

    expect(screen.getByRole("link", { name: "PLC-02" })).toHaveAttribute(
      "href",
      `/factories/${FACTORY_ID}/plcs/id-PLC-02`,
    );
    const valve = within(screen.getByText("XV-201").closest("tr") as HTMLElement);
    expect(valve.getByText("Valve")).toBeInTheDocument();
    expect(valve.getByText("Generic / simulated Generic Valve")).toBeInTheDocument();
    expect(valve.getByText("Stopped")).toBeInTheDocument();
    // Every other device opens its own screen.
    expect(screen.getByRole("link", { name: "XV-201" })).toHaveAttribute(
      "href",
      `/factories/${FACTORY_ID}/devices/id-XV-201`,
    );
  });

  it("offers no drop-down controls when nothing is connected", () => {
    render(<DeviceTree factoryId={FACTORY_ID} nodes={[node("PLC-01", "PLC"), node("LS-9", "Switch")]} />);

    expect(names()).toEqual(["PLC-01", "LS-9"]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
