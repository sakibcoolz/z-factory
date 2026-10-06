import type { Metadata } from "next";
import { StoredDeviceParameters } from "../stored-device";

export const metadata: Metadata = { title: "Device parameters" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ factoryId: string; deviceId: string }> };

export default async function Page({ params }: PageProps) {
  const { factoryId, deviceId } = await params;
  return StoredDeviceParameters({ factoryId, deviceId });
}
