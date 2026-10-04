/**
 * Fixture access for the wireframe screens. Pages resolve route params through these
 * helpers so that swapping fixtures for real services later only touches this seam.
 */
import type { FactoryContext } from "@/components/shell/app-shell";
import { DEMO_FACTORY_ID, DEMO_PLC_ID, MODULAR_BENCH_FACTORY_ID } from "./factories";

export const demoContext: FactoryContext = { factoryId: DEMO_FACTORY_ID, plcId: DEMO_PLC_ID };

/** True when the factory has screen fixtures (only the Pump House Demo does). */
export function isDemoFactory(factoryId: string): boolean {
  return factoryId === DEMO_FACTORY_ID;
}

export function isDemoPlc(factoryId: string, plcId: string): boolean {
  return isDemoFactory(factoryId) && plcId === DEMO_PLC_ID;
}

export function isModularBenchFactory(factoryId: string): boolean {
  return factoryId === MODULAR_BENCH_FACTORY_ID;
}
