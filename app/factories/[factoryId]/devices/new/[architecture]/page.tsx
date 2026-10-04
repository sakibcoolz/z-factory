import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CompactPlcConfig } from "@/components/plc/compact-plc-config";
import { ModularPlcConfig } from "@/components/plc/modular-plc-config";
import { isDemoFactory, isModularBenchFactory } from "@/lib/fixtures";

export const metadata: Metadata = { title: "New device" };

type NewDevicePageProps = {
  params: Promise<{ factoryId: string; architecture: string }>;
};

/**
 * 2f / 2g — Device Configuration. Compact and modular PLCs are separate branches
 * (ADR-0003): built-in I/O with a pin view vs CPU › rack › slots › modules.
 */
export default async function NewDevicePage({ params }: NewDevicePageProps) {
  const { factoryId, architecture } = await params;

  if (architecture === "compact" && isDemoFactory(factoryId)) {
    return <CompactPlcConfig factoryId={factoryId} />;
  }
  if (architecture === "modular" && isModularBenchFactory(factoryId)) {
    return <ModularPlcConfig />;
  }
  notFound();
}
