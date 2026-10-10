import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeviceShell } from "@/components/device/device-shell";
import { ParametersForm } from "@/components/device/parameters-form";
import type { DeviceDetailView } from "@/lib/domain/device-detail-view";
import { parameterFieldsFor } from "@/lib/domain/device-parameters";
import type { OperationState } from "@/lib/plc/operation-state";

const FACTORY_ID = "01a107ff-de99-71ec-adbb-40049a4cf552";
const DEVICE_ID = "01a10a0d-e48d-744e-ba58-dfb344f7e884";

const device = (overrides: Partial<DeviceDetailView> = {}): DeviceDetailView => ({
  id: DEVICE_ID,
  factoryId: FACTORY_ID,
  factoryName: "Pump House",
  factorySlug: "pump-house",
  name: "VFD-02",
  role: null,
  location: null,
  runtimeStatus: "STOPPED",
  categoryCode: "VFD",
  categoryName: "Variable-frequency drive",
  manufacturer: "Generic / simulated",
  modelId: "m-vfd",
  modelName: "Generic VFD, Modbus TCP",
  architectureType: null,
  runtimeSupport: "NONE",
  simulatorType: "VFD",
  capabilities: ["PARAMETER_CONFIGURABLE", "REMOTE_CONTROL", "MODBUS_SERVER"],
  sections: [
    { key: "overview", label: "Overview" },
    { key: "connections", label: "Connections" },
    { key: "parameters", label: "Parameters" },
    { key: "registers", label: "Registers" },
    { key: "communications", label: "Communications" },
    { key: "runtime", label: "Runtime" },
  ],
  programNote: null,
  ports: [{ name: "Ethernet", physicalType: "Ethernet", protocols: ["MODBUS_TCP"], maxConnections: 16 }],
  wires: [],
  registers: [],
  parameters: null,
  ...overrides,
});

describe("device shell", () => {
  it("lists only the screens the model's capabilities give it, and links them", () => {
    render(
      <DeviceShell device={device()} section="registers">
        <p>body</p>
      </DeviceShell>,
    );
    const nav = within(screen.getByRole("complementary", { name: "VFD-02" }));
    expect(nav.getByRole("link", { name: /Parameters/ })).toHaveAttribute(
      "href",
      `/factories/${FACTORY_ID}/devices/${DEVICE_ID}/parameters`,
    );
    expect(nav.getByRole("link", { name: /Communications/ })).toBeInTheDocument();
    // The factory simulator is named as what it is (TASK-1005).
    expect(nav.getByRole("link", { name: /Simulator/ })).toHaveAttribute("href", `/factories/${FACTORY_ID}/simulator`);
    expect(nav.queryByRole("link", { name: /Runtime/ })).not.toBeInTheDocument();
    expect(nav.queryByText("Program")).not.toBeInTheDocument();
    expect(nav.queryByText("Versions")).not.toBeInTheDocument();
    expect(nav.getByText("parameter-configurable, remote control, Modbus server")).toBeInTheDocument();
  });

  it("hides a programmable model's program screens when no adapter runs them (TASK-1005)", () => {
    render(
      <DeviceShell
        device={device({
          capabilities: ["PROGRAMMABLE", "SCRIPTABLE"],
          sections: [
            { key: "overview", label: "Overview" },
            { key: "connections", label: "Connections" },
            { key: "program", label: "Program" },
            { key: "versions", label: "Versions" },
          ],
          programNote: "This model is not programmed in an IEC 61131-3 language; no adapter exists for it.",
        })}
        section="overview"
      >
        <p>body</p>
      </DeviceShell>,
    );
    const nav = within(screen.getByRole("complementary", { name: "VFD-02" }));
    // No dead entry: the overview and the LLM Context say why there is no program.
    expect(nav.queryByText("Program")).not.toBeInTheDocument();
    expect(nav.queryByText("Versions")).not.toBeInTheDocument();
    expect(nav.queryByText("no adapter")).not.toBeInTheDocument();
    expect(nav.getByRole("link", { name: /Connections/ })).toBeInTheDocument();
  });
});

describe("parameters form", () => {
  it("shows each parameter with its unit, limits and default, and submits the values", async () => {
    const action = vi.fn(async (_state: OperationState, _formData: FormData) => ({ notice: "Saved as version 1." }));
    render(<ParametersForm fields={parameterFieldsFor("VFD")} values={{ maxFrequencyHz: 60 }} action={action} />);

    expect(screen.getByLabelText("Maximum output frequency")).toHaveValue(60);
    expect(screen.getByLabelText("Acceleration time")).toHaveValue(5);
    expect(screen.getByText("> 0 · ≤ 1000")).toBeInTheDocument();
    expect(screen.getByText("Time to ramp from zero to the maximum frequency.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Deceleration time"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Saved as version 1.");
    const formData = action.mock.calls[0]?.[1];
    expect(Object.fromEntries(formData?.entries() ?? [])).toEqual({
      maxFrequencyHz: "60",
      accelTimeS: "5",
      decelTimeS: "12",
    });
  });

  it("shows why a save was refused", async () => {
    const action = vi.fn(async () => ({ message: "Deceleration time: Too small: expected number to be >0." }));
    render(<ParametersForm fields={parameterFieldsFor("VFD")} values={{}} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Deceleration time: Too small");
  });
});
