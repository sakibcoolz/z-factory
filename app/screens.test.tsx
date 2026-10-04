import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import CatalogPage from "@/app/catalog/page";
import DesignerPage from "@/app/factories/[factoryId]/designer/page";
import NewDevicePage from "@/app/factories/[factoryId]/devices/new/[architecture]/page";
import EventsPage from "@/app/factories/[factoryId]/events/page";
import ExportPage from "@/app/factories/[factoryId]/plcs/[plcId]/export/page";
import IoMappingPage from "@/app/factories/[factoryId]/plcs/[plcId]/io-mapping/page";
import PlcPage from "@/app/factories/[factoryId]/plcs/[plcId]/page";
import ProgramPage from "@/app/factories/[factoryId]/plcs/[plcId]/program/page";
import RuntimePage from "@/app/factories/[factoryId]/runtime/page";
import SimulatorPage from "@/app/factories/[factoryId]/simulator/page";
import TagsPage from "@/app/factories/[factoryId]/tags/page";
import TopologyPage from "@/app/factories/[factoryId]/topology/page";
import View3dPage from "@/app/factories/[factoryId]/view-3d/page";
import NewFactoryPage from "@/app/factories/new/page";
import FactoriesPage from "@/app/factories/page";
import WelcomePage from "@/app/welcome/page";
import { RUNTIME_STATES, runtimeStateLabel } from "@/lib/domain/runtime-state";
import { DEMO_FACTORY_ID, DEMO_PLC_ID, MODULAR_BENCH_FACTORY_ID } from "@/lib/fixtures/factories";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: vi.fn(),
}));

const factoryParams = Promise.resolve({ factoryId: DEMO_FACTORY_ID });
const plcParams = Promise.resolve({ factoryId: DEMO_FACTORY_ID, plcId: DEMO_PLC_ID });
const deviceParams = (factoryId: string, architecture: string) => Promise.resolve({ factoryId, architecture });

type Screen = {
  id: string;
  heading: string | RegExp;
  activity: string;
  element: () => ReactElement | Promise<ReactElement>;
};

/** Every wireframe screen (2a–2q) with the heading or landmark that identifies it. */
const SCREENS: Screen[] = [
  { id: "2a factories", heading: "Factories", activity: "Factories", element: () => <FactoriesPage /> },
  { id: "2b welcome", heading: "Build a virtual plant.", activity: "Factories", element: () => <WelcomePage /> },
  { id: "2c create factory", heading: "Create factory", activity: "Factories", element: () => <NewFactoryPage /> },
  {
    id: "2d designer",
    heading: "Inspector",
    activity: "Designer",
    element: () => DesignerPage({ params: factoryParams }),
  },
  { id: "2e catalog", heading: "CPU 1214C DC/DC/DC", activity: "Device catalog", element: () => <CatalogPage /> },
  {
    id: "2f compact device config",
    heading: "Built-in I/O & pin view",
    activity: "Designer",
    element: () => NewDevicePage({ params: deviceParams(DEMO_FACTORY_ID, "compact") }) as Promise<ReactElement>,
  },
  {
    id: "2g modular device config",
    heading: "Rack 0 · backplane",
    activity: "Designer",
    element: () =>
      NewDevicePage({ params: deviceParams(MODULAR_BENCH_FACTORY_ID, "modular") }) as Promise<ReactElement>,
  },
  {
    id: "2h plc overview",
    heading: "S7-1200-1214C-01",
    activity: "Designer",
    element: () => PlcPage({ params: plcParams }),
  },
  { id: "2i plc program", heading: "Program", activity: "Designer", element: () => ProgramPage({ params: plcParams }) },
  {
    id: "2j io mapping",
    heading: "Conventions",
    activity: "Designer",
    element: () => IoMappingPage({ params: plcParams }),
  },
  {
    id: "2k simulator",
    heading: "Devices",
    activity: "Runtime",
    element: () => SimulatorPage({ params: factoryParams }),
  },
  { id: "2l live tags", heading: "Tags", activity: "Live tags", element: () => TagsPage({ params: factoryParams }) },
  { id: "2m events", heading: "Events", activity: "Events", element: () => EventsPage({ params: factoryParams }) },
  { id: "2n runtime", heading: "Runtime", activity: "Runtime", element: () => RuntimePage({ params: factoryParams }) },
  {
    id: "2o topology",
    heading: "Layers",
    activity: "Designer",
    element: () => TopologyPage({ params: factoryParams }),
  },
  {
    id: "2p export",
    heading: /Pump Station Controller/,
    activity: "PLC export",
    element: () => ExportPage({ params: plcParams }),
  },
  { id: "2q 3d view", heading: "Scene", activity: "Designer", element: () => View3dPage({ params: factoryParams }) },
];

describe("wireframe screens", () => {
  it.each(SCREENS)("$id renders inside the shell", async ({ heading, activity, element }) => {
    render(await element());

    expect(screen.getAllByRole("heading", { name: heading }).length).toBeGreaterThan(0);
    const activities = within(screen.getByRole("navigation", { name: "Activities" }));
    expect(activities.getByLabelText(activity)).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("covers all 17 wireframe screens", () => {
    expect(SCREENS).toHaveLength(17);
  });

  it("rejects factories and PLCs that have no screen", async () => {
    await expect(DesignerPage({ params: Promise.resolve({ factoryId: "factory_999" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(
      PlcPage({ params: Promise.resolve({ factoryId: DEMO_FACTORY_ID, plcId: "dev_999" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(NewDevicePage({ params: deviceParams(DEMO_FACTORY_ID, "modular") })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("factories screen", () => {
  it("shows a distinct pill for every runtime state", () => {
    render(<FactoriesPage />);

    const tones = RUNTIME_STATES.map((state) => {
      const pills = screen.getAllByText(runtimeStateLabel(state), { selector: ".zf-st" });
      return pills[0]?.getAttribute("data-tone");
    });
    expect(tones.every(Boolean)).toBe(true);
    // STARTING and STOPPING share the transitional tone by design; the rest are unique.
    expect(new Set(tones).size).toBe(RUNTIME_STATES.length - 1);
  });

  it("only links factories that have a screen", () => {
    render(<FactoriesPage />);

    const table = within(screen.getByRole("table"));
    expect(table.getAllByRole("link", { name: "Open" })).toHaveLength(2);
    expect(table.getAllByRole("button", { name: "Open" })).toHaveLength(2);
    for (const button of table.getAllByRole("button", { name: "Open" })) {
      expect(button).toBeDisabled();
    }
  });

  it("disables factory-scoped activities until a factory is open", () => {
    render(<FactoriesPage />);

    const activities = within(screen.getByRole("navigation", { name: "Activities" }));
    expect(activities.getByLabelText("Designer")).toHaveAttribute("aria-disabled", "true");
    expect(activities.getByLabelText("Device catalog")).toHaveAttribute("href", "/catalog");
  });
});

describe("live tags screen", () => {
  it("offers writes only on command/setpoint tags", async () => {
    render(await TagsPage({ params: factoryParams }));

    const row = (tag: string) => within(screen.getByText(tag).closest("tr") as HTMLElement);
    expect(row("Pump01_StartCommand").getByRole("button", { name: "Toggle" })).toBeInTheDocument();
    expect(row("VFD01_FrequencySetpoint").getByRole("button", { name: "Write" })).toBeInTheDocument();
    for (const tag of ["VFD01_ActualFrequency", "Motor01_ActualRPM", "Pump01_Fault", "GW01_Heartbeat"]) {
      expect(row(tag).queryByRole("button")).toBeNull();
      expect(row(tag).getByText("read-only")).toBeInTheDocument();
    }
  });
});

describe("simulator screen", () => {
  it("separates command/setpoint from actual feedback", async () => {
    render(await SimulatorPage({ params: factoryParams }));

    expect(screen.getByText("VFD-01 · command / setpoint")).toBeInTheDocument();
    expect(screen.getByText("VFD-01 · actual feedback")).toBeInTheDocument();
    expect(screen.getByText("45.0 Hz")).toBeInTheDocument();
    expect(screen.getByText("44.8 Hz")).toBeInTheDocument();
  });
});

describe("i/o mapping screen", () => {
  it("flags the duplicate channel and counts unmapped rows", async () => {
    render(await IoMappingPage({ params: plcParams }));

    expect(screen.getByText(/duplicate of PT101_High/)).toBeInTheDocument();
    expect(screen.getByText("9 tags · 2 unmapped · duplicates blocked")).toBeInTheDocument();
  });
});
