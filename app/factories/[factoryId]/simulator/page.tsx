import type { Metadata } from "next";
import { StoredSimulator } from "./stored-simulator";

export const metadata: Metadata = { title: "Simulator" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type SimulatorPageProps = { params: Promise<{ factoryId: string }> };

/** 2k — the device simulation of a stored factory. */
export default async function SimulatorPage({ params }: SimulatorPageProps) {
  const { factoryId } = await params;
  return StoredSimulator({ factoryId });
}
