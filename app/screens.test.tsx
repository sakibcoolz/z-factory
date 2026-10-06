import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import DesignerPage from "@/app/factories/[factoryId]/designer/page";
import DeviceConnectionsPage from "@/app/factories/[factoryId]/devices/[deviceId]/connections/page";
import DevicePage from "@/app/factories/[factoryId]/devices/[deviceId]/page";
import DeviceParametersPage from "@/app/factories/[factoryId]/devices/[deviceId]/parameters/page";
import NewDevicePage from "@/app/factories/[factoryId]/devices/new/[architecture]/page";
import EventsPage from "@/app/factories/[factoryId]/events/page";
import GatewaysPage from "@/app/factories/[factoryId]/gateways/page";
import ModulePage from "@/app/factories/[factoryId]/modules/[moduleId]/page";
import ModulesPage from "@/app/factories/[factoryId]/modules/page";
import FactoryPage from "@/app/factories/[factoryId]/page";
import ConnectionsPage from "@/app/factories/[factoryId]/plcs/[plcId]/connections/page";
import ExportPage from "@/app/factories/[factoryId]/plcs/[plcId]/export/page";
import HardwarePage from "@/app/factories/[factoryId]/plcs/[plcId]/hardware/page";
import IoMappingPage from "@/app/factories/[factoryId]/plcs/[plcId]/io-mapping/page";
import PlcPage from "@/app/factories/[factoryId]/plcs/[plcId]/page";
import ProgramPage from "@/app/factories/[factoryId]/plcs/[plcId]/program/page";
import PlcRuntimePage from "@/app/factories/[factoryId]/plcs/[plcId]/runtime/page";
import VersionsPage from "@/app/factories/[factoryId]/plcs/[plcId]/versions/page";
import RuntimePage from "@/app/factories/[factoryId]/runtime/page";
import SimulatorPage from "@/app/factories/[factoryId]/simulator/page";
import TagsPage from "@/app/factories/[factoryId]/tags/page";
import TopologyPage from "@/app/factories/[factoryId]/topology/page";
import View3dPage from "@/app/factories/[factoryId]/view-3d/page";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

/** The ids the design fixtures of TASK-104 answered to, and ids that never existed. */
const FORMER_FIXTURE_IDS = ["factory_001", "factory_003", "dev_001", "factory_999", "dev_999"];

const params = (factoryId: string, rest: Record<string, string> = {}) => Promise.resolve({ factoryId, ...rest });

type Page = (props: { params: Promise<never>; searchParams?: Promise<never> }) => Promise<unknown>;

/** Every screen of a factory, a PLC and a device, with the params it takes for an id that is no stored row. */
const SCREENS: Array<[name: string, render: (id: string) => Promise<unknown>]> = [
  ["factory overview", (id) => (FactoryPage as Page)({ params: params(id) as never })],
  ["designer", (id) => (DesignerPage as Page)({ params: params(id) as never })],
  ["topology", (id) => (TopologyPage as Page)({ params: params(id) as never })],
  ["3D view", (id) => (View3dPage as Page)({ params: params(id) as never })],
  ["runtime", (id) => (RuntimePage as Page)({ params: params(id) as never })],
  ["simulator", (id) => (SimulatorPage as Page)({ params: params(id) as never })],
  ["live tags", (id) => (TagsPage as Page)({ params: params(id) as never })],
  ["events", (id) => (EventsPage as Page)({ params: params(id) as never })],
  ["gateways", (id) => (GatewaysPage as Page)({ params: params(id) as never })],
  ["process modules", (id) => (ModulesPage as Page)({ params: params(id) as never })],
  ["process module", (id) => (ModulePage as Page)({ params: params(id, { moduleId: id }) as never })],
  ["new PLC", (id) => (NewDevicePage as Page)({ params: params(id, { architecture: "compact" }) as never })],
  ["PLC overview", (id) => (PlcPage as Page)({ params: params(id, { plcId: id }) as never })],
  [
    "PLC hardware",
    (id) =>
      (HardwarePage as Page)({
        params: params(id, { plcId: id }) as never,
        searchParams: Promise.resolve({}) as never,
      }),
  ],
  ["PLC connections", (id) => (ConnectionsPage as Page)({ params: params(id, { plcId: id }) as never })],
  ["PLC program", (id) => (ProgramPage as Page)({ params: params(id, { plcId: id }) as never })],
  ["PLC I/O mapping", (id) => (IoMappingPage as Page)({ params: params(id, { plcId: id }) as never })],
  ["PLC versions", (id) => (VersionsPage as Page)({ params: params(id, { plcId: id }) as never })],
  ["PLC runtime", (id) => (PlcRuntimePage as Page)({ params: params(id, { plcId: id }) as never })],
  ["PLC export", (id) => (ExportPage as Page)({ params: params(id, { plcId: id }) as never })],
  ["device", (id) => (DevicePage as Page)({ params: params(id, { deviceId: id }) as never })],
  ["device connections", (id) => (DeviceConnectionsPage as Page)({ params: params(id, { deviceId: id }) as never })],
  ["device parameters", (id) => (DeviceParametersPage as Page)({ params: params(id, { deviceId: id }) as never })],
];

/**
 * Since TASK-309 every screen reads stored data: there is no fixture factory, no fixture
 * PLC and no id that is answered without a database row.
 */
describe("screens without fixtures", () => {
  it.each(SCREENS)("%s is not found for a former fixture id or an unknown id", async (_name, render) => {
    for (const id of FORMER_FIXTURE_IDS) await expect(render(id)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("has no module that imports the fixtures", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry)) files.push(path);
      }
    };
    for (const dir of ["app", "components", "lib"]) walk(dir);
    const importers = files.filter((file) => /@\/lib\/fixtures|lib\/fixtures\//.test(readFileSync(file, "utf8")));
    expect(importers).toEqual([]);
    expect(files.some((file) => file.startsWith(join("lib", "fixtures")))).toBe(false);
  });
});
