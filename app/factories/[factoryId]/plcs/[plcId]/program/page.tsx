import type { Metadata } from "next";
import { StoredPlcProgram } from "../stored-runtime-screens";

export const metadata: Metadata = { title: "PLC program" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type ProgramPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
  searchParams?: Promise<{ version?: string | string[] }>;
};

/** 2i — the program editor of a stored PLC; `version` opens a stored version instead of the selected one. */
export default async function ProgramPage({ params, searchParams }: ProgramPageProps) {
  const { factoryId, plcId } = await params;
  const requested = (await searchParams)?.version;
  const version = typeof requested === "string" && /^[1-9]\d{0,8}$/.test(requested) ? Number(requested) : undefined;
  return StoredPlcProgram({ factoryId, plcId, version });
}
