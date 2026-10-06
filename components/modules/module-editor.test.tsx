import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ModuleDesignerView } from "@/lib/domain/module-designer-view";
import type { ModuleIoCandidate, ModuleIoRow } from "@/lib/domain/module-io-view";
import type { ModuleSignal } from "@/lib/domain/process-module";
import type { ModuleDetail, ModuleTypeDetail } from "@/lib/domain/process-module-view";
import { type ModuleEditorActions, ModuleEditor } from "./module-editor";
import { NewModuleForm } from "./module-form";
import { ModuleList } from "./module-list";

const noop = async () => ({});
const actions: ModuleEditorActions = {
  update: noop,
  device: noop,
  signal: noop,
  interlock: noop,
  importIo: noop,
  bridge: noop,
  override: () => noop,
};

const signal = (
  key: string,
  direction: ModuleSignal["direction"],
  dataType: ModuleSignal["dataType"],
  extra: Partial<ModuleSignal> = {},
): ModuleSignal => ({
  key,
  name: key.toLowerCase().replaceAll("_", " "),
  description: null,
  direction,
  dataType,
  role: direction === "OUTPUT" ? "COMMAND" : direction === "ALARM" ? "ALARM" : "FEEDBACK",
  unit: null,
  signalType: null,
  required: true,
  rangeMin: null,
  rangeMax: null,
  roleKey: null,
  profiles: [],
  ...extra,
});

const SIGNALS = [
  signal("RUN_CMD", "OUTPUT", "BOOL"),
  signal("SPEED_SP", "OUTPUT", "FLOAT32", { role: "SETPOINT", required: false, unit: "%" }),
  signal("RUNNING", "INPUT", "BOOL"),
  signal("PRESSURE", "INPUT", "FLOAT32", { role: "PROCESS_VALUE", unit: "bar" }),
  signal("FLOW", "INTERNAL", "FLOAT32", { role: "PROCESS_VALUE", required: false }),
  signal("LOW", "ALARM", "BOOL", { required: false }),
];

const type: ModuleTypeDetail = {
  id: "type-1",
  code: "PUMP_HOUSE",
  name: "Pump house",
  version: 1,
  description: "One pump on a discharge line.",
  simulatorModelType: "PUMP_HOUSE",
  profiles: ["SINGLE_PUMP", "DUTY_STANDBY"],
  latest: true,
  roleCount: 2,
  signalCounts: {
    INPUT: { required: 2, optional: 0 },
    OUTPUT: { required: 1, optional: 1 },
    INTERNAL: { required: 0, optional: 1 },
    ALARM: { required: 0, optional: 1 },
  },
  configFields: [
    {
      key: "ratedFlow",
      label: "Rated flow",
      type: "number",
      unit: "m3/h",
      min: 0.1,
      max: null,
      options: [],
      defaultValue: 50,
    },
    {
      key: "duty",
      label: "Duty",
      type: "choice",
      unit: null,
      min: null,
      max: null,
      options: ["CONTINUOUS", "INTERMITTENT"],
      defaultValue: "CONTINUOUS",
    },
  ],
  roles: [],
  signals: SIGNALS,
};

const tank: ModuleTypeDetail = {
  ...type,
  id: "type-2",
  code: "TANK",
  name: "Tank",
  profiles: [],
  configFields: [
    { key: "volume", label: "Volume", type: "number", unit: "m3", min: 0.01, max: null, options: [], defaultValue: 10 },
  ],
  signals: [],
};

const detail: ModuleDetail = {
  id: "m1",
  factoryId: "f1",
  name: "PH-01",
  location: "Hall 2",
  status: "STOPPED",
  profile: "SINGLE_PUMP",
  type: { id: "type-1", code: "PUMP_HOUSE", name: "Pump house", version: 1 },
  deviceCount: 1,
  signalCounts: type.signalCounts,
  complete: false,
  issues: [{ rule: "module-role-empty", subject: "SENSOR", message: "Pressure transmitter has no device." }],
  bindings: { bound: 2, invalid: 1, requiredUnbound: 1 },
  readyToRun: false,
  config: { ratedFlow: 60, duty: "CONTINUOUS" },
  configFields: type.configFields,
  roles: [
    {
      key: "PUMP",
      name: "Duty pump",
      description: null,
      deviceCategoryCodes: ["PUMP"],
      required: true,
      maxDevices: 1,
      profiles: [],
      devices: [
        {
          assignmentId: "a1",
          deviceId: "d1",
          name: "P-01",
          categoryCode: "PUMP",
          categoryName: "Pump",
          manufacturer: "Generic",
          modelName: "Centrifugal",
        },
      ],
    },
    {
      key: "SENSOR",
      name: "Pressure transmitter",
      description: null,
      deviceCategoryCodes: ["SENSOR"],
      required: true,
      maxDevices: 1,
      profiles: [],
      devices: [],
    },
  ],
  signals: SIGNALS,
  interlocks: [
    {
      id: "i1",
      code: "HIGH_PRESSURE_STOP",
      name: "Stop on high pressure",
      description: null,
      severity: "WARNING",
      enabled: true,
      expression: { when: [{ signal: "PRESSURE", operator: "GT", value: 5 }], blocks: ["RUN_CMD"] },
    },
  ],
};

const binding = (tagName: string, logicalAddress: string): NonNullable<ModuleIoRow["binding"]> => ({
  mappingId: `map-${tagName}`,
  plcId: "plc-1",
  plcName: "PLC-01",
  tagId: `tag-${tagName}`,
  tagName,
  logicalAddress,
  dataType: "BOOL",
  modbusArea: "COIL",
  modbusAddress: 8192,
  scale: 1,
  offset: 0,
  unit: null,
  ioPointId: null,
});

const rows: ModuleIoRow[] = [
  { signal: SIGNALS[0]!, state: "BOUND", blocking: false, issue: null, binding: binding("PH_Run_Cmd", "%QX100.0") },
  { signal: SIGNALS[1]!, state: "UNBOUND", blocking: false, issue: null, binding: null },
  {
    signal: SIGNALS[2]!,
    state: "INVALID",
    blocking: true,
    issue: { rule: "tag-in-use", message: "Tag PH_Running already carries a device signal." },
    binding: binding("PH_Running", "%MX10.0"),
  },
  { signal: SIGNALS[3]!, state: "UNBOUND", blocking: true, issue: null, binding: null },
  { signal: SIGNALS[5]!, state: "BOUND", blocking: false, issue: null, binding: binding("PH_Low", "%MX10.1") },
];

const candidate = (
  tagName: string,
  refusal: ModuleIoCandidate["refusal"] = null,
  heldBy: ModuleIoCandidate["heldBy"] = null,
): ModuleIoCandidate => ({
  tagId: `tag-${tagName}`,
  plcId: "plc-1",
  plcName: "PLC-01",
  tagName,
  logicalAddress: "%MD12",
  dataType: "FLOAT32",
  role: "PROCESS_VALUE",
  unit: "bar",
  refusal,
  heldBy,
});

const view: ModuleDesignerView = {
  factory: { id: "f1", name: "Milk" },
  module: detail,
  type,
  registry: {
    moduleId: "m1",
    name: "PH-01",
    profile: "SINGLE_PUMP",
    type: { code: "PUMP_HOUSE", name: "Pump house", version: 1, simulatorModelType: "PUMP_HOUSE" },
    readyToRun: false,
    rows,
    internal: [SIGNALS[4]!],
    counts: {
      INPUT: { total: 2, bound: 0, invalid: 1, requiredUnbound: 1 },
      OUTPUT: { total: 2, bound: 1, invalid: 0, requiredUnbound: 0 },
      ALARM: { total: 1, bound: 1, invalid: 0, requiredUnbound: 0 },
    },
    plcs: [{ plcId: "plc-1", plcName: "PLC-01", inputs: 0, outputs: 1, alarms: 1 }],
  },
  candidates: {
    PRESSURE: [
      candidate("PT_Pressure"),
      candidate("Start_Cmd", { rule: "signal-plc-driven", message: "Tag Start_Cmd can be written by a gateway." }),
      candidate(
        "Other_Level",
        { rule: "tag-mapped", message: "Carries LEVEL of TK-01." },
        { module: "TK-01", signal: "LEVEL" },
      ),
    ],
  },
  assignable: {
    SENSOR: [
      {
        deviceId: "d2",
        name: "PT-01",
        categoryCode: "SENSOR",
        categoryName: "Sensor",
        modelName: "Generic transmitter",
      },
    ],
    PUMP: [],
  },
  plcs: [{ plcId: "plc-1", name: "PLC-01", signals: 2 }],
  runtime: {
    bridgeRunning: false,
    status: null,
    quality: null,
    tick: 0,
    timeS: 0,
    inputs: {},
    outputs: {},
    alarms: [],
    plcs: [],
    error: null,
    serviceNote: null,
    testInputs: [],
  },
};

describe("module editor", () => {
  it("shows the consumed PLC I/O registry with every state and what blocks the module", () => {
    render(<ModuleEditor view={view} actions={actions} />);
    const registry = within(screen.getByRole("table", { name: "Consumed PLC I/O registry" }));
    const states = registry
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.getAttribute("data-state"));
    expect(states).toEqual(["BOUND", "UNBOUND", "INVALID", "UNBOUND", "BOUND"]);
    expect(registry.getByText("required · unbound")).toBeInTheDocument();
    expect(registry.getByText("optional · unbound")).toBeInTheDocument();
    expect(registry.getByText("invalid")).toBeInTheDocument();
    expect(registry.getByText("Tag PH_Running already carries a device signal.")).toBeInTheDocument();
    expect(registry.getAllByText("bound")).toHaveLength(2);
    expect(screen.getByText("2 of 5")).toBeInTheDocument();
    expect(screen.getAllByText("1 required unbound · 1 invalid")).toHaveLength(2);
    expect(screen.getByText("1 issue · 1 required unbound · 1 invalid")).toBeInTheDocument();
    expect(screen.getByText("Internal to the process model, not bound to a tag: FLOW.")).toBeInTheDocument();
    expect(screen.getByText("Pressure transmitter has no device.")).toBeInTheDocument();
  });

  it("offers only free compatible tags; the others are listed disabled with the reason", () => {
    render(<ModuleEditor view={view} actions={actions} />);
    const picker = screen.getByRole("combobox", { name: "Tag for pressure" }) as HTMLSelectElement;
    const options = [...picker.options].map((option) => [option.disabled, option.textContent]);
    expect(options).toEqual([
      [false, "PLC-01 · PT_Pressure · %MD12 · FLOAT32 bar"],
      [true, "PLC-01 · Start_Cmd · %MD12 · FLOAT32 bar — Tag Start_Cmd can be written by a gateway."],
      [true, "PLC-01 · Other_Level · %MD12 · FLOAT32 bar — Carries LEVEL of TK-01."],
    ]);
    const form = within(screen.getByRole("form", { name: "Bind pressure" }));
    expect(form.getByRole("button", { name: "Bind" })).toBeEnabled();
    expect(form.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
    // A bound signal is moved or released; without a free tag it cannot be moved.
    const bound = within(screen.getByRole("form", { name: "Bind run cmd" }));
    expect(bound.getByRole("button", { name: "Move" })).toBeDisabled();
    expect(bound.getByRole("button", { name: "Release" })).toBeEnabled();
  });

  it("assigns only devices of a fitting category and shows the ones in a role", () => {
    render(<ModuleEditor view={view} actions={actions} />);
    const sensor = screen.getByRole("combobox", { name: "Device for Pressure transmitter" }) as HTMLSelectElement;
    expect([...sensor.options].map((option) => option.textContent)).toEqual(["PT-01 · Sensor · Generic transmitter"]);
    expect(screen.getByText("no device — required")).toBeInTheDocument();
    const pump = screen.getByRole("combobox", { name: "Device for Duty pump" }) as HTMLSelectElement;
    expect(pump).toBeDisabled();
    expect(screen.getByRole("link", { name: "P-01" })).toHaveAttribute("href", "/factories/f1/devices/d1");
  });

  it("lists interlocks, the topology and the export, and keeps the bridge button off until the module is ready", () => {
    render(<ModuleEditor view={view} actions={actions} />);
    expect(screen.getByText("PRESSURE GT 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start process bridge" })).toBeDisabled();
    const figure = screen.getByRole("figure", { name: "Topology of PH-01" });
    expect(figure).toHaveTextContent("PLC PLC-01");
    expect(figure).toHaveTextContent("2 signals bound");
    expect(figure).toHaveTextContent("pressure transmitter");
    expect(screen.getByRole("link", { name: "Bindings by names (module-io.json)" })).toHaveAttribute(
      "href",
      "/factories/f1/modules/m1/export/module-io.json",
    );
    const when = screen.getByLabelText("While signal") as HTMLSelectElement;
    fireEvent.change(when, { target: { value: "PRESSURE" } });
    expect(screen.getByLabelText("Value (bar)")).toBeInTheDocument();
    fireEvent.change(when, { target: { value: "RUN_CMD" } });
    expect(screen.queryByLabelText(/^Value/)).not.toBeInTheDocument();
  });

  it("shows live values and the stop button while the bridge runs the module", () => {
    const running: ModuleDesignerView = {
      ...view,
      module: { ...detail, readyToRun: true, status: "RUNNING" },
      runtime: {
        ...view.runtime,
        bridgeRunning: true,
        status: "RUNNING",
        quality: "DISCONNECTED",
        tick: 40,
        timeS: 4,
        inputs: { RUN_CMD: 1 },
        outputs: { RUNNING: 1, PRESSURE: 2.94, FLOW: 42, LOW: 0 },
        alarms: [],
        plcs: [{ plcId: "plc-1", up: false }],
      },
    };
    render(<ModuleEditor view={running} actions={actions} />);
    expect(screen.getByRole("button", { name: "Stop process bridge" })).toBeEnabled();
    expect(screen.getByText("disconnected")).toBeInTheDocument();
    const live = within(screen.getByRole("table", { name: "Live process values" }));
    expect(live.getByText("2.94 bar")).toBeInTheDocument();
    expect(live.getAllByText("on")).toHaveLength(2);
    expect(live.getByText("42")).toBeInTheDocument();
  });
});

describe("test inputs (Phase 08)", () => {
  const running = (testInputs: ModuleDesignerView["runtime"]["testInputs"]): ModuleDesignerView => ({
    ...view,
    module: { ...detail, readyToRun: true, status: "RUNNING" },
    runtime: {
      ...view.runtime,
      bridgeRunning: true,
      status: "RUNNING",
      quality: "GOOD",
      tick: 100,
      timeS: 10,
      outputs: { PRESSURE: 3.5 },
      testInputs,
    },
  });
  const pressure = {
    signal: "PRESSURE",
    name: "pressure",
    unit: "bar",
    bool: false,
    min: 0,
    max: 12,
    mode: "AUTO" as const,
    calculated: 2.94,
    effective: 2.94,
    value: null,
    profile: null,
    sinceTimeS: 0,
    source: null,
    tag: "PLC-01 · PH_Pressure",
  };

  it("lists each value the PLC reads with what is delivered and where it comes from, and warns", () => {
    render(
      <ModuleEditor
        view={running([
          pressure,
          {
            ...pressure,
            signal: "VALVE_OPEN",
            name: "valve open",
            unit: "",
            bool: true,
            min: 0,
            max: 1,
            effective: 1,
            calculated: 0,
            mode: "MANUAL_OVERRIDE",
            value: 1,
            sinceTimeS: 4.2,
            source: "alice",
            tag: null,
          },
        ])}
        actions={actions}
      />,
    );
    const table = within(screen.getByRole("table", { name: "Test inputs" }));
    expect(table.getByText("2.94 bar")).toBeInTheDocument();
    expect(table.getByText("AUTO")).toBeInTheDocument();
    expect(table.getByText("from the model")).toBeInTheDocument();
    expect(table.getByText("pressure → PLC-01 · PH_Pressure")).toBeInTheDocument();
    expect(table.getByText("MANUAL_OVERRIDE")).toBeInTheDocument();
    expect(table.getByText("model: off")).toBeInTheDocument();
    expect(table.getByText("since 4.2 s · by alice")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/may switch outputs/);
    // Clear is offered only where there is something to clear.
    const rows = table.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(within(rows[1]!).getByRole("button", { name: "Clear" })).toBeEnabled();
    // A switch takes on/off, a number a value or a ramp.
    expect(within(rows[1]!).getByRole("combobox", { name: "Value for VALVE_OPEN" })).toBeInTheDocument();
    fireEvent.change(within(rows[0]!).getByRole("combobox", { name: "Mode for PRESSURE" }), {
      target: { value: "SCENARIO" },
    });
    expect(within(rows[0]!).getByRole("spinbutton", { name: "Ramp to for PRESSURE" })).toBeInTheDocument();
  });

  it("shows no test controls while the module does not run", () => {
    render(<ModuleEditor view={view} actions={actions} />);
    expect(screen.queryByRole("table", { name: "Test inputs" })).not.toBeInTheDocument();
  });
});

describe("module list and new-module form", () => {
  it("lists readiness per module", () => {
    render(
      <ModuleList
        factoryId="f1"
        modules={[
          detail,
          {
            ...detail,
            id: "m2",
            name: "PH-02",
            readyToRun: true,
            issues: [],
            bindings: { bound: 5, invalid: 0, requiredUnbound: 0 },
          },
        ]}
      />,
    );
    expect(screen.getByText("1 issue · 1 required unbound · 1 invalid")).toBeInTheDocument();
    expect(screen.getByText("ready to run")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PH-02" })).toHaveAttribute("href", "/factories/f1/modules/m2");
  });

  it("offers the profiles and settings of the selected type and nothing of another", () => {
    render(<NewModuleForm types={[type, tank]} action={noop} />);
    expect(screen.getByLabelText("Profile")).toBeInTheDocument();
    expect(screen.getByLabelText("Rated flow")).toHaveValue(50);
    expect((screen.getByLabelText("Duty") as HTMLSelectElement).options).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "type-2" } });
    expect(screen.queryByLabelText("Profile")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rated flow")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Volume")).toHaveValue(10);
    expect(screen.getByRole("button", { name: "Create module" })).toBeEnabled();
  });

  it("says when no type is installed", () => {
    render(<NewModuleForm types={[]} action={noop} />);
    expect(screen.getByText(/No module type is installed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create module" })).toBeDisabled();
  });
});
