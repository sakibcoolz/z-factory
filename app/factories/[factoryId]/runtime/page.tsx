import type { Metadata } from "next";
import { StoredFactoryRuntime } from "./stored-runtime";

export const metadata: Metadata = { title: "Runtime" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type RuntimePageProps = { params: Promise<{ factoryId: string }> };

/** 2n — the PLC runtimes and the device simulation of a stored factory. */
export default async function RuntimePage({ params }: RuntimePageProps) {
  const { factoryId } = await params;
  return StoredFactoryRuntime({ factoryId });
}
