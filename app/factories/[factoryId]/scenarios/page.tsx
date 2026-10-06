import type { Metadata } from "next";
import { StoredScenarios } from "./stored-scenarios";

export const metadata: Metadata = { title: "Scenarios" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type ScenariosPageProps = { params: Promise<{ factoryId: string }> };

/** Closed-loop test scenarios of a stored factory (TASK-804). */
export default async function ScenariosPage({ params }: ScenariosPageProps) {
  const { factoryId } = await params;
  return StoredScenarios({ factoryId });
}
