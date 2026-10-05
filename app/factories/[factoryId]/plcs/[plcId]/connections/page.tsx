import type { Metadata } from "next";
import { StoredPlcConnections } from "../stored-screens";

export const metadata: Metadata = { title: "PLC connections" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type ConnectionsPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
};

/** Devices wired to a PLC: a read-only projection of the factory's wiring. */
export default async function ConnectionsPage({ params }: ConnectionsPageProps) {
  const { factoryId, plcId } = await params;
  return StoredPlcConnections({ factoryId, plcId });
}
