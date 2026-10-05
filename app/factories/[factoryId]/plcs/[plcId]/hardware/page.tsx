import type { Metadata } from "next";
import { StoredPlcHardware } from "../stored-screens";

export const metadata: Metadata = { title: "PLC hardware" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type HardwarePageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
  searchParams: Promise<{ pin?: string | string[] }>;
};

/** 2f / 2g — pin view of a PLC, with rack and modules for a modular one. */
export default async function HardwarePage({ params, searchParams }: HardwarePageProps) {
  const { factoryId, plcId } = await params;
  const { pin } = await searchParams;
  return StoredPlcHardware({ factoryId, plcId, pin: typeof pin === "string" ? pin : undefined });
}
