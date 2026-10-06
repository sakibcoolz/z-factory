import type { Metadata } from "next";
import { StoredPlcOverview } from "./stored-screens";

export const metadata: Metadata = { title: "PLC" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type PlcPageProps = { params: Promise<{ factoryId: string; plcId: string }> };

/** 2f — the overview of a stored PLC. */
export default async function PlcPage({ params }: PlcPageProps) {
  const { factoryId, plcId } = await params;
  return StoredPlcOverview({ factoryId, plcId });
}
