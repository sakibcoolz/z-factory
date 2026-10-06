import type { Metadata } from "next";
import { StoredEvents } from "./stored-events";

export const metadata: Metadata = { title: "Events" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type EventsPageProps = {
  params: Promise<{ factoryId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** 2m — alarms and recorded events of a stored factory, filtered by the query. */
export default async function EventsPage({ params, searchParams }: EventsPageProps) {
  const { factoryId } = await params;
  const query = (await searchParams) ?? {};
  const text = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);
  return StoredEvents({
    factoryId,
    filter: { family: text(query.family), severity: text(query.severity), device: text(query.device) },
  });
}
