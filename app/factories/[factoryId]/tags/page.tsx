import type { Metadata } from "next";
import { StoredTags } from "./stored-tags";

export const metadata: Metadata = { title: "Live tags" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type TagsPageProps = {
  params: Promise<{ factoryId: string }>;
  searchParams?: Promise<{ plc?: string | string[] }>;
};

/** 2l — the live tags of a stored factory, optionally narrowed to one PLC. */
export default async function TagsPage({ params, searchParams }: TagsPageProps) {
  const { factoryId } = await params;
  const plc = (await searchParams)?.plc;
  return StoredTags({ factoryId, plcId: typeof plc === "string" ? plc : undefined });
}
