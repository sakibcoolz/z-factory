import type { Metadata } from "next";
import { StoredPlcRuntime } from "../stored-runtime-screens";

export const metadata: Metadata = { title: "PLC runtime" };

export const dynamic = "force-dynamic";

type RuntimePageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
};

/** Lifecycle and state of a stored PLC's runtime. */
export default async function PlcRuntimePage({ params }: RuntimePageProps) {
  return StoredPlcRuntime(await params);
}
