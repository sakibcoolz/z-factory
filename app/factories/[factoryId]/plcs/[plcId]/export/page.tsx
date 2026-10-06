import type { Metadata } from "next";
import { StoredPlcExport } from "../stored-screens";

export const metadata: Metadata = { title: "PLC export" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type ExportPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
  searchParams?: Promise<{ runtime?: string | string[] }>;
};

/** 2p — the engineering export of a stored PLC; `runtime=1` includes the live runtime state. */
export default async function ExportPage({ params, searchParams }: ExportPageProps) {
  const { factoryId, plcId } = await params;
  return StoredPlcExport({ factoryId, plcId, runtime: (await searchParams)?.runtime === "1" });
}
