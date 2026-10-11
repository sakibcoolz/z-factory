import { describe, expect, it } from "vitest";
import type { GatewaysView } from "@/lib/domain/gateway-view";
import type { ModuleDesignerView, ModulesScreenView } from "@/lib/domain/module-designer-view";
import type { FactoryDeviceView } from "@/lib/domain/plc-config-view";
import type { SimulationView } from "@/lib/domain/simulation-view";
import type { AlarmView, EventView } from "@/lib/services/event-service";
import type { FactoryView } from "@/lib/services/factory-service";
import type { LiveTagsView } from "@/lib/services/live-service";
import { LLM_CONTEXT_SECTIONS } from "../llm-context";
import { buildLlmIndex } from "../llm-index";
import { buildGatewaysContext, buildModuleEditorContext, buildModulesContext } from "./factory-engineering";
import {
  buildEventsContext,
  buildFactoryRuntimeContext,
  buildLiveTagsContext,
  buildScenariosContext,
  buildSimulatorContext,
} from "./factory-operations";
import { LLM_CONTEXT_AREAS } from "./registry";

const F = "01a10a0d-e48d-744e-ba58-dfb344f7e880";
const P = "01a10a0d-e48d-744e-ba58-dfb344f7e883";
const V = "01a10a0d-e48d-744e-ba58-dfb344f7e884";

const factory = (overrides: Partial<FactoryView> = {}): FactoryView => ({
  id: F,
  name: "Pump House",
  slug: "pump-house",
  description: null,
  status: "DRAFT",
  runtimeStatus: "STOPPED",
  dockerNetworkName: `zfactory_${F}`,
  subnetCidr: "172.20.1.0/24",
  deviceCount: 2,
  plcCount: 1,
  lastEvent: null,
  createdAt: "2026-10-10T06:00:00.000Z",
  updatedAt: "2026-10-10T06:00:00.000Z",
  ...overrides,
});

const plc: FactoryDeviceView = {
  id: P,
  name: "PLC-01",
  role: null,
  modelName: "CPU 1214C DC/DC/DC",
  manufacturer: "Siemens",
  categoryCode: "PLC",
  categoryName: "PLC / programmable controller",
  architectureType: "COMPACT",
  runtimeStatus: "STOPPED",
};
const valve: FactoryDeviceView = {
  ...plc,
  id: V,
  name: "XV-101",
  modelName: "Generic on/off valve",
  categoryCode: "VALVE",
  categoryName: "Valve",
  architectureType: null,
};

const labels = (items: readonly { label: string }[]) => items.map((item) => item.label);
const complete = (document: ReturnType<typeof buildFactoryRuntimeContext>) => {
  for (const { id } of LLM_CONTEXT_SECTIONS) expect(document).toHaveProperty(id);
  expect(document.navigation.map((item) => item.href)).not.toContain(document.identity.route);
};

describe("the registry of PR B", () => {
  it("names the factory-level areas, and the LLM Index follows", () => {
    for (const key of ["runtime", "simulation", "tags", "events", "gateways", "modules"])
      expect(LLM_CONTEXT_AREAS.has(key)).toBe(true);
    expect(
      new Set(
        buildLlmIndex()
          .areas.filter((area) => area.llmContext)
          .map((area) => area.key),
      ),
    ).toEqual(LLM_CONTEXT_AREAS);
  });
});

describe("the factory runtime context", () => {
  it("gates Start on Docker and a PLC, and reads the PLCs and the simulation", () => {
    const stopped = buildFactoryRuntimeContext({
      factory: factory(),
      devices: [plc, valve],
      simulation: { running: false },
      docker: { reachable: true, version: "29.7.2" },
    });
    expect(stopped.identity).toMatchObject({
      page: "Factory runtime",
      area: "runtime",
      routePattern: "/factories/[factoryId]/runtime",
    });
    expect(labels(stopped.objects)).toEqual(["PLC-01"]);
    expect(stopped.context.find((item) => item.label === "PLC runtimes started")?.value).toBe("0/1");
    expect(stopped.actions.find((item) => item.label === "Start factory")).toMatchObject({ tone: "warn" });
    expect(labels(stopped.decisions)).toEqual(["Start the plant?"]);
    complete(stopped);

    const dark = buildFactoryRuntimeContext({
      factory: factory(),
      devices: [valve],
      simulation: { running: false },
      docker: { reachable: false },
    });
    expect(labels(dark.validation.items)).toEqual(["Docker Engine unreachable", "No PLC to start"]);
    expect(dark.actions.find((item) => item.label === "Start factory")?.detail).toMatch(/Disabled/);
    expect(dark.decisions).toEqual([]);

    const running = buildFactoryRuntimeContext({
      factory: factory({ runtimeStatus: "DEGRADED" }),
      devices: [{ ...plc, runtimeStatus: "FAULTED" }],
      simulation: {
        running: true,
        factoryId: F,
        tickMs: 100,
        ticks: 5,
        startedAt: "2026-10-10T06:00:00.000Z",
        lastError: "cycle failed",
        devices: [],
      },
      docker: { reachable: true },
    });
    expect(labels(running.validation.items)).toEqual(["PLC-01 is faulted", "The simulation's last cycle failed"]);
    expect(running.actions.find((item) => item.label === "Stop factory")).toMatchObject({ tone: "warn" });
    expect(labels(running.decisions)).toEqual(["The plant is running"]);
  });
});

const simulationView = (overrides: Partial<SimulationView> = {}): SimulationView => ({
  running: true,
  tickMs: 100,
  ticks: 42,
  startedAt: "2026-10-10T06:00:00.000Z",
  lastError: null,
  devices: [
    {
      deviceId: V,
      name: "XV-101",
      type: "VALVE",
      state: "OPEN",
      faulted: true,
      tripped: false,
      quality: "BAD",
      inputs: [{ key: "cmd", label: "Open command", kind: "COMMAND", unit: null, value: true, tag: "XV_101_Y1" }],
      outputs: [{ key: "zso", label: "Opened", kind: "FEEDBACK", unit: null, value: true, tag: "XV_101_ZSO" }],
      faults: [{ code: "STUCK", name: "Stuck", latching: true, active: true }],
    } as unknown as SimulationView["devices"][number],
  ],
  skipped: [{ deviceId: "x", name: "GW-01", reason: "not a simulated device" }],
  plcs: [{ id: P, name: "PLC-01", runtimeStatus: "RUNNING", endpointReady: true }],
  blocker: null,
  ...overrides,
});

describe("the simulator context", () => {
  it("reads devices with their wired signals, faults and the skipped ones", () => {
    const context = buildSimulatorContext({ factory: factory({ runtimeStatus: "RUNNING" }), view: simulationView() });
    expect(context.identity).toMatchObject({ page: "Simulator", area: "simulation" });
    expect(context.objects[0]).toMatchObject({ label: "XV-101", tone: "fault", href: `/factories/${F}/devices/${V}` });
    expect(context.objects[0]?.detail).toContain("commands: Open command ← XV_101_Y1");
    expect(labels(context.relationships)).toEqual([
      "XV-101.Open command is driven by tag XV_101_Y1",
      "XV-101.Opened feeds tag XV_101_ZSO",
    ]);
    expect(labels(context.validation.items)).toEqual(["XV-101 is faulted", "GW-01 is not simulated"]);
    expect(context.validation.items[0]?.value).toBe("Stuck");
    expect(labels(context.actions)).toEqual(["Stop simulation", "Inject a fault", "Reset a device"]);
    expect(labels(context.decisions)).toEqual(["Which fault, on which device?"]);
    complete(context);
  });

  it("names the blocker and the endpoint that is not ready when stopped", () => {
    const context = buildSimulatorContext({
      factory: factory(),
      view: simulationView({
        running: false,
        ticks: null,
        tickMs: null,
        startedAt: null,
        blocker: "No PLC endpoint is ready.",
        devices: [],
        skipped: [],
        plcs: [{ id: P, name: "PLC-01", runtimeStatus: "STOPPED", endpointReady: false }],
      }),
    });
    expect(labels(context.validation.items)).toEqual([
      "The simulation cannot start",
      "PLC-01's Modbus endpoint is not ready",
    ]);
    expect(context.actions[0]).toMatchObject({ label: "Start simulation", tone: "info" });
    expect(context.decisions).toEqual([]);
  });
});

describe("the scenarios context", () => {
  it("reads overrides, runs and the example scenario, and says when the service is silent", () => {
    const runs: EventView[] = [
      {
        version: 1,
        id: "e1",
        type: "SCENARIO_PASSED",
        factoryId: F,
        deviceId: null,
        severity: "INFO",
        occurredAt: "2026-10-10T06:01:00.000Z",
        payload: { name: "trip" },
        deviceName: null,
        family: "SCENARIO",
      },
    ];
    const context = buildScenariosContext({
      factory: factory(),
      active: [{ kind: "FORCED", target: "PT-101", mode: "MANUAL_OVERRIDE", value: 3.5 }],
      runs,
      examplePlc: { name: "PLC-01", command: "Pump_Start", expected: "VFD_01_RUN" },
    });
    expect(context.identity).toMatchObject({
      page: "Scenarios",
      area: "simulation",
      routePattern: "/factories/[factoryId]/scenarios",
    });
    expect(labels(context.validation.items)).toEqual(["1 override out of AUTO"]);
    expect(context.objects.map((item) => item.label)).toEqual(["PT-101", "SCENARIO_PASSED"]);
    expect(context.objects[1]?.detail).toBe("trip");
    expect(context.context.find((item) => item.label === "Example scenario")?.value).toBe(
      "PLC-01: Pump_Start → VFD_01_RUN",
    );
    complete(context);

    const silent = buildScenariosContext({ factory: factory(), active: null, runs: [], examplePlc: null });
    expect(labels(silent.validation.items)).toEqual(["The simulation service does not answer", "No PLC"]);
    expect(silent.actions.find((item) => item.label === "Clear all overrides")?.detail).toMatch(/Unavailable/);
  });
});

const liveTags: LiveTagsView = {
  plcs: [{ id: P, name: "PLC-01", runtimeStatus: "RUNNING", monitored: true, tagCount: 2 }],
  tags: [
    {
      plcId: P,
      plcName: "PLC-01",
      name: "Pump_Start",
      role: "COMMAND",
      dataType: "BOOL",
      unit: null,
      logicalAddress: "%QX101.0",
      writable: true,
      authority: "EXTERNAL_COMMAND",
      deviceName: null,
      reading: { plcId: P, name: "Pump_Start", value: true, quality: "GOOD", readAt: "2026-10-10T06:00:00.000Z" },
    },
    {
      plcId: P,
      plcName: "PLC-01",
      name: "PT_101",
      role: "FEEDBACK",
      dataType: "FLOAT32",
      unit: "bar",
      logicalAddress: "%IW100",
      writable: false,
      authority: "FIELD_INPUT",
      deviceName: "PT-101",
      reading: { plcId: P, name: "PT_101", value: 2.6, quality: "STALE", readAt: "2026-10-10T05:59:00.000Z" },
    },
  ] as LiveTagsView["tags"],
  staleAfterMs: 2000,
};

describe("the live tags context", () => {
  it("counts writable and stale tags, narrows to a PLC and warns before a write", () => {
    const context = buildLiveTagsContext({
      factory: factory({ runtimeStatus: "RUNNING" }),
      view: liveTags,
      selectedPlcId: P,
    });
    expect(context.identity).toMatchObject({
      page: "Live tags",
      area: "tags",
      route: `/factories/${F}/tags?plc=${P}`,
      subject: "Pump House · PLC-01",
    });
    expect(context.context.find((item) => item.label === "Writable")?.value).toBe("1");
    expect(labels(context.validation.items)).toEqual(["1 tag not GOOD"]);
    expect(context.objects[0]).toMatchObject({ label: "PLC-01.Pump_Start", value: "true · good", tone: "ok" });
    expect(context.objects[0]?.detail).toContain("writable");
    expect(context.objects[1]).toMatchObject({ value: "2.6 bar · stale", tone: "warn" });
    expect(context.actions[0]).toMatchObject({ label: "Write a tag", tone: "warn" });
    complete(context);

    const idle = buildLiveTagsContext({
      factory: factory(),
      view: {
        plcs: [{ ...liveTags.plcs[0]!, monitored: false, runtimeStatus: "STOPPED" }],
        tags: [],
        staleAfterMs: 2000,
      },
    });
    expect(labels(idle.validation.items)).toEqual(["No PLC is started and monitored"]);
    expect(idle.actions[0]?.detail).toBe("No writable tag here.");
  });
});

describe("the events context", () => {
  it("lists active alarms as issues, counts and filters, and asks before acknowledging", () => {
    const alarms: AlarmView[] = [
      {
        id: "a1",
        code: "HIGH_PRESSURE",
        severity: "CRITICAL",
        message: "High pressure",
        deviceId: V,
        deviceName: "XV-101",
        tagName: "PT_101_HI",
        startedAt: "2026-10-10T06:00:00.000Z",
        clearedAt: null,
        acknowledgedAt: null,
        state: "ACTIVE_UNACKNOWLEDGED",
      },
      {
        id: "a2",
        code: "OLD",
        severity: "WARNING",
        message: "Cleared one",
        deviceId: null,
        deviceName: null,
        tagName: null,
        startedAt: "2026-10-09T06:00:00.000Z",
        clearedAt: "2026-10-09T07:00:00.000Z",
        acknowledgedAt: "2026-10-09T07:00:00.000Z",
        state: "CLEARED",
      },
    ];
    const events: EventView[] = [
      {
        version: 1,
        id: "e1",
        type: "DEVICE_FAULTED",
        factoryId: F,
        deviceId: V,
        severity: "CRITICAL",
        occurredAt: "2026-10-10T06:00:00.000Z",
        payload: {},
        deviceName: "XV-101",
        family: "DEVICE",
      },
    ];
    const context = buildEventsContext({
      factory: factory(),
      alarms,
      events,
      counts: { INFO: 3, WARNING: 1, CRITICAL: 1 },
      filter: { severity: "CRITICAL", deviceName: "XV-101" },
      retention: { telemetryMs: 24 * 3_600_000, eventsMs: 30 * 86_400_000 },
    });
    expect(context.identity).toMatchObject({ page: "Events and alarms", area: "events" });
    expect(context.context.find((item) => item.label === "Active alarms")).toMatchObject({ value: "1", tone: "warn" });
    expect(context.context.find((item) => item.label === "Events shown")?.detail).toBe(
      "filtered: severity CRITICAL, device XV-101",
    );
    expect(context.context.find((item) => item.label === "Retention")?.value).toBe("events 30 days · telemetry 24 h");
    expect(context.validation.items).toEqual([
      expect.objectContaining({ label: "XV-101: High pressure", value: "active unacknowledged", tone: "fault" }),
    ]);
    expect(context.objects[0]).toMatchObject({
      label: "DEVICE_FAULTED",
      tone: "fault",
      href: `/factories/${F}/events?device=${V}`,
    });
    expect(labels(context.decisions)).toEqual(["Acknowledge on the user's behalf?"]);
    complete(context);
  });
});

const gateways: GatewaysView = {
  factory: { id: F, name: "Pump House" },
  gateways: [
    {
      deviceId: "01a10a0d-e48d-744e-ba58-dfb344f7e890",
      name: "GATEWAY-01",
      modelName: "Generic Modbus TCP gateway",
      availablePlcs: [],
      connections: [
        {
          id: "01a10a0d-e48d-744e-ba58-dfb344f7e891",
          plcId: P,
          plcName: "PLC-01",
          plcState: "RUNNING",
          host: "127.0.0.1",
          port: 15500,
          unitId: 1,
          pollIntervalMs: 500,
          enabled: true,
          endpoint: {
            listening: false,
            error: "address in use",
            clients: 0,
            requests: 0,
            refused: 0,
            lastRequestAt: null,
          },
          registers: [
            {
              mappingId: "m1",
              tagId: "t1",
              tagName: "Pump_Start",
              externalName: "PUMP_START",
              role: "COMMAND",
              dataType: "BOOL",
              area: "COIL",
              address: 0,
              displayAddress: "00001",
              wordCount: 1,
              access: "READ_WRITE",
              unit: null,
            },
          ],
          unmappedTags: [{ id: "t2", name: "PT_101", role: "FEEDBACK", dataType: "FLOAT32", writable: false }],
        } as GatewaysView["gateways"][number]["connections"][number],
      ],
    },
  ],
  bindAddresses: ["127.0.0.1"],
  portRange: { min: 15000, max: 15999 },
  suggestedPort: 15501,
  hasPlc: true,
};

describe("the gateways context", () => {
  it("reads connections, their endpoints and registers, and flags a failed endpoint", () => {
    const context = buildGatewaysContext(gateways);
    expect(context.identity).toMatchObject({
      page: "External gateways",
      area: "gateways",
      routePattern: "/factories/[factoryId]/gateways",
    });
    expect(context.context.find((item) => item.label === "Connections")).toMatchObject({
      value: "1 configured · 0 listening",
      tone: "fault",
    });
    expect(labels(context.objects)).toEqual(["GATEWAY-01", "GATEWAY-01 → PLC-01"]);
    expect(context.objects[1]).toMatchObject({ value: "127.0.0.1:15500 unit 1 · enabled · not open", tone: "fault" });
    expect(labels(context.relationships)).toEqual(["GATEWAY-01 exposes PLC-01.Pump_Start as PUMP_START"]);
    expect(labels(context.validation.items)).toEqual([
      "GATEWAY-01 → PLC-01: endpoint not open",
      "GATEWAY-01 → PLC-01: 1 tag not mapped",
    ]);
    expect(context.validation.items[0]?.detail).toBe("address in use");
    expect(labels(context.decisions)).toEqual([
      "Which host address and port?",
      "Which tags may an external client write?",
    ]);
    complete(context);
  });
});

const moduleDetail: ModulesScreenView["modules"][number] = {
  id: "01a10a0d-e48d-744e-ba58-dfb344f7e8a0",
  factoryId: F,
  name: "Tank T-01",
  location: null,
  status: "STOPPED",
  profile: "basic",
  type: { id: "ty", code: "TANK", name: "Tank", version: 2 },
  deviceCount: 1,
  signalCounts: {
    INPUT: { required: 1, optional: 0 },
    OUTPUT: { required: 1, optional: 0 },
    ALARM: { required: 0, optional: 0 },
    INTERNAL: { required: 0, optional: 0 },
  } as unknown as ModulesScreenView["modules"][number]["signalCounts"],
  complete: false,
  issues: [{ rule: "module-role-empty", message: "The role Level sensor has no device.", subject: "level" }],
  config: { volumeL: 500 },
  configFields: [],
  roles: [
    {
      key: "tank",
      name: "Tank",
      description: null,
      deviceCategoryCodes: ["TANK"],
      required: true,
      maxDevices: 1,
      profiles: [],
      devices: [
        {
          assignmentId: "as1",
          deviceId: V,
          name: "TK-01",
          categoryCode: "TANK",
          categoryName: "Tank",
          manufacturer: "Generic",
          modelName: "Generic tank",
        } as unknown as unknown as ModulesScreenView["modules"][number]["roles"][number]["devices"][number],
      ],
    },
    {
      key: "level",
      name: "Level sensor",
      description: null,
      deviceCategoryCodes: ["SENSOR"],
      required: true,
      maxDevices: 1,
      profiles: [],
      devices: [],
    },
  ],
  signals: [],
  interlocks: [],
} as unknown as ModulesScreenView["modules"][number];

describe("the process module contexts", () => {
  it("lists modules with their issues and types with their process model", () => {
    const context = buildModulesContext({
      factory: { id: F, name: "Pump House" },
      modules: [moduleDetail],
      types: [
        {
          id: "ty",
          code: "TANK",
          name: "Tank",
          version: 2,
          description: null,
          simulatorModelType: null,
          profiles: ["basic"],
          latest: true,
          roleCount: 2,
          configFields: [],
          roles: [],
          signals: [],
        } as unknown as ModulesScreenView["types"][number],
      ],
    });
    expect(context.identity).toMatchObject({ page: "Process modules", area: "modules" });
    expect(context.objects[0]).toMatchObject({
      label: "Tank T-01",
      tone: "warn",
      href: `/factories/${F}/modules/${moduleDetail.id}`,
    });
    expect(labels(context.relationships)).toEqual(["TK-01 is the Tank of Tank T-01"]);
    expect(context.capacity[0]).toMatchObject({ label: "Tank", tone: "warn" });
    expect(labels(context.validation.items)).toEqual(["Tank T-01: The role Level sensor has no device."]);
    // The issue carries its rule's explanation, so an agent knows what the rule expects and what to do.
    expect(context.validation.items[0]?.explanation).toMatchObject({
      rule: "module-role-empty",
      kind: "fixable",
      object: "Tank T-01",
      destination: "level",
      area: "modules",
    });
    complete(context);
  });

  it("reads the editor: roles, the I/O registry, interlocks, the bridge and the open decisions", () => {
    const view: ModuleDesignerView = {
      factory: { id: F, name: "Pump House" },
      module: moduleDetail,
      type: {
        id: "ty",
        code: "TANK",
        name: "Tank",
        version: 2,
        description: null,
        simulatorModelType: "tank",
        profiles: ["basic"],
        latest: true,
        roleCount: 2,
        configFields: [],
        roles: [
          {
            key: "tank",
            name: "Tank",
            description: null,
            deviceCategoryCodes: ["TANK"],
            required: true,
            maxDevices: 1,
            profiles: [],
          },
          {
            key: "level",
            name: "Level sensor",
            description: null,
            deviceCategoryCodes: ["SENSOR"],
            required: true,
            maxDevices: 1,
            profiles: [],
          },
          // Of another profile: the page does not offer it, so neither does the context (TASK-1008).
          {
            key: "temperature",
            name: "Temperature sensor",
            description: null,
            deviceCategoryCodes: ["SENSOR"],
            required: true,
            maxDevices: 1,
            profiles: ["extended"],
          },
        ],
        signals: [],
      } as unknown as ModuleDesignerView["type"],
      registry: {
        moduleId: moduleDetail.id,
        name: "Tank T-01",
        profile: "basic",
        type: { code: "TANK", name: "Tank", version: 2, simulatorModelType: "tank" },
        readyToRun: false,
        rows: [
          {
            signal: {
              key: "level",
              name: "Level",
              description: null,
              direction: "OUTPUT",
              dataType: "FLOAT32",
              role: "FEEDBACK",
              unit: "%",
              signalType: null,
              required: true,
            },
            state: "UNBOUND",
            blocking: true,
            issue: null,
            binding: null,
          },
          {
            signal: {
              key: "inlet",
              name: "Inlet valve",
              description: null,
              direction: "INPUT",
              dataType: "BOOL",
              role: "COMMAND",
              unit: null,
              signalType: null,
              required: true,
            },
            state: "BOUND",
            blocking: false,
            issue: null,
            binding: {
              mappingId: "mp",
              plcId: P,
              plcName: "PLC-01",
              tagId: "t",
              tagName: "XV_101_Y1",
              logicalAddress: "%QX0.0",
              dataType: "BOOL",
              modbusArea: null,
              modbusAddress: null,
            } as ModuleDesignerView["registry"]["rows"][number]["binding"],
          },
        ] as ModuleDesignerView["registry"]["rows"],
        internal: [],
        counts: {
          INPUT: { total: 1, bound: 1, invalid: 0, requiredUnbound: 0 },
          OUTPUT: { total: 1, bound: 0, invalid: 0, requiredUnbound: 1 },
          ALARM: { total: 0, bound: 0, invalid: 0, requiredUnbound: 0 },
        },
        plcs: [{ plcId: P, plcName: "PLC-01", inputs: 1, outputs: 0, alarms: 0 }],
      },
      candidates: {},
      assignable: {},
      plcs: [{ plcId: P, name: "PLC-01", signals: 1 }],
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
        serviceNote: "The process simulation service is not configured.",
        testInputs: [],
      },
    };
    const context = buildModuleEditorContext(view);
    expect(context.identity).toMatchObject({
      page: "Process module",
      area: "modules",
      routePattern: "/factories/[factoryId]/modules/[moduleId]",
      subject: "Tank T-01 (Pump House)",
    });
    expect(labels(context.objects)).toEqual(["TK-01", "Signal Level", "Signal Inlet valve"]);
    expect(context.objects[2]?.detail).toBe("bound to PLC-01.XV_101_Y1");
    expect(labels(context.relationships)).toEqual(["TK-01 fills role Tank", "Tank T-01 uses PLC-01"]);
    expect(context.capacity.find((item) => item.label === "Role Level sensor")).toMatchObject({
      value: "0/1 (required)",
      tone: "warn",
    });
    expect(labels(context.validation.items)).toEqual([
      "The role Level sensor has no device.",
      "Required signal Level is not bound",
      "Process simulation service",
    ]);
    expect(context.validation.items[0]?.explanation).toMatchObject({ rule: "module-role-empty", object: "Tank T-01" });
    expect(labels(context.decisions)).toEqual([
      "Which device for Level sensor?",
      "Which PLC tags carry the required signals?",
    ]);
    expect(labels(context.capacity).filter((label) => label.startsWith("Role "))).toEqual([
      "Role Tank",
      "Role Level sensor",
    ]);
    expect(context.navigation.find((item) => item.label === "PLC-01 I/O mapping")?.href).toBe(
      `/factories/${F}/plcs/${P}/io-mapping`,
    );
    complete(context);
  });
});
