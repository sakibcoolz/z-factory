import type { Metadata } from "next";
import { StoredPlcIoMapping } from "../stored-screens";

export const metadata: Metadata = { title: "PLC I/O mapping" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type IoMappingPageProps = { params: Promise<{ factoryId: string; plcId: string }> };

/** 2j — channel › program address › Modbus address › tag › device of a stored PLC. */
export default async function IoMappingPage({ params }: IoMappingPageProps) {
  const { factoryId, plcId } = await params;
  return StoredPlcIoMapping({ factoryId, plcId });
}
