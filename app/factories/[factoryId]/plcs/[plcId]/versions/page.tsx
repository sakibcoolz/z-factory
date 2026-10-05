import type { Metadata } from "next";
import { StoredPlcVersions } from "../stored-runtime-screens";

export const metadata: Metadata = { title: "PLC versions" };

export const dynamic = "force-dynamic";

type VersionsPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
};

/** Program versions and deployment snapshots of a stored PLC. */
export default async function VersionsPage({ params }: VersionsPageProps) {
  return StoredPlcVersions(await params);
}
