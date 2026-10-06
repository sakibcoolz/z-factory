import type { Metadata } from "next";
import { StoredCanvas } from "./stored-designer";

export const metadata: Metadata = { title: "Designer" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type DesignerPageProps = { params: Promise<{ factoryId: string }> };

/** 2d — the factory designer of a stored factory. */
export default async function DesignerPage({ params }: DesignerPageProps) {
  const { factoryId } = await params;
  return StoredCanvas({ factoryId, mode: "designer" });
}
