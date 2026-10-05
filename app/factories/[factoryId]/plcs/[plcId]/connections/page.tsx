import type { Metadata } from "next";
import { StoredPlcConnections } from "../stored-screens";

export const metadata: Metadata = { title: "PLC connections" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type ConnectionsPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
  searchParams: Promise<{ add?: string | string[] }>;
};

/** Devices connected to a PLC and the catalog peripherals it can still take. */
export default async function ConnectionsPage({ params, searchParams }: ConnectionsPageProps) {
  const { factoryId, plcId } = await params;
  const { add } = await searchParams;
  return StoredPlcConnections({ factoryId, plcId, add: typeof add === "string" ? add : undefined });
}
