import type { Metadata } from "next";
import { StoredCanvas } from "../designer/stored-designer";

export const metadata: Metadata = { title: "Topology" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type TopologyPageProps = { params: Promise<{ factoryId: string }> };

/** 2o — the read-only topology view of a stored factory. */
export default async function TopologyPage({ params }: TopologyPageProps) {
  const { factoryId } = await params;
  return StoredCanvas({ factoryId, mode: "topology" });
}
