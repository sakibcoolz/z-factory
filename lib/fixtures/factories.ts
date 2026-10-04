/**
 * Static design fixtures transcribed from the Claude Design wireframes (turn 2).
 * Not live runtime state and not persisted data — TASK-103 replaces this with factory CRUD.
 */
import type { RuntimeState } from "@/lib/domain/runtime-state";
import { routes } from "@/lib/navigation/routes";

export type FactorySummary = {
  id: string;
  name: string;
  /** One-line signal chain shown under the name. */
  summary?: string;
  deviceCount: number;
  plcCount: number;
  networkName: string | null;
  state: RuntimeState;
  lastEvent: string;
  /** Screen the "Open" action leads to; null while no screen fixture exists for the factory. */
  href: string | null;
};

export const DEMO_FACTORY_ID = "factory_001";
export const DEMO_PLC_ID = "dev_001";
export const MODULAR_BENCH_FACTORY_ID = "factory_003";

export const factories: readonly FactorySummary[] = [
  {
    id: DEMO_FACTORY_ID,
    name: "Pump House Demo",
    summary: "PT-101 → S7-1200-1214C-01 → VFD-01 → MOTOR-01 → PUMP-01 · gateway-01",
    deviceCount: 6,
    plcCount: 1,
    networkName: "zfactory_factory_001",
    state: "RUNNING",
    lastEvent: "PUMP_STATE_CHANGED · 2 s",
    href: routes.designer(DEMO_FACTORY_ID),
  },
  {
    id: "factory_002",
    name: "Conveyor Line A",
    deviceCount: 11,
    plcCount: 2,
    networkName: "zfactory_factory_002",
    state: "DEGRADED",
    lastEvent: "CONNECTION_DOWN · 14 m",
    href: null,
  },
  {
    id: MODULAR_BENCH_FACTORY_ID,
    name: "Modular S7-1500 bench",
    deviceCount: 3,
    plcCount: 1,
    networkName: "zfactory_factory_003",
    state: "FAULTED",
    lastEvent: "CONTAINER_EXITED · 1 h",
    href: routes.newDevice(MODULAR_BENCH_FACTORY_ID, "modular"),
  },
  {
    id: "factory_004",
    name: "Empty sandbox",
    deviceCount: 0,
    plcCount: 0,
    networkName: null,
    state: "STOPPED",
    lastEvent: "FACTORY_CREATED · 3 d",
    href: null,
  },
];

export const host = {
  dockerEngine: "27.3",
  openPlcImageDigest: "sha256:9f2…",
  freePortRange: "15021–15099",
} as const;

export const factoryTemplates = [
  {
    name: "Primary demo",
    description: "PT-101 · S7-1200 PLC · VFD-01 · MOTOR-01 · PUMP-01 · gateway-01",
    selected: true,
  },
  { name: "Empty", description: "network only", selected: false },
  { name: "Import JSON", description: "normalized config package", selected: false },
] as const;
