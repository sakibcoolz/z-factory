import type { Metadata } from "next";
import { StoredView3d } from "./stored-view-3d";

export const metadata: Metadata = { title: "3D view" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type View3dPageProps = { params: Promise<{ factoryId: string }> };

/** 2q — the 3D scene of a stored factory. */
export default async function View3dPage({ params }: View3dPageProps) {
  const { factoryId } = await params;
  return StoredView3d({ factoryId });
}
