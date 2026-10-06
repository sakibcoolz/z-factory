import type { Metadata } from "next";
import { PlcCommunication } from "@/components/plc/plc-communication";
import { StoredPlcShell } from "@/components/plc/stored-plc-shell";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { routes } from "@/lib/navigation/routes";
import { getPlcCommunicationView } from "@/lib/services/plc-communication-service";
import { getPlcLinkDeps } from "@/lib/services/runtime-deps";
import { loadPlc } from "../load-plc";
import { addMappingAction, createLinkAction, linkAction, mappingAction } from "./actions";

export const metadata: Metadata = { title: "PLC communication" };

// Reads the database and the link monitor of this server process on every request.
export const dynamic = "force-dynamic";

type CommunicationPageProps = { params: Promise<{ factoryId: string; plcId: string }> };

/** The PLC's links to other PLCs of the factory (Phase 07, TASK-704). */
export default async function CommunicationPage({ params }: CommunicationPageProps) {
  const { factoryId, plcId } = await params;
  const { actor, db, factory, view } = await loadPlc(factoryId, plcId);
  const deps = getPlcLinkDeps();
  const communication = await getPlcCommunicationView(db, actor, view.plc.id, deps.monitor);
  return (
    <StoredPlcShell factory={factory} view={view} section="communication">
      {communication.watched ? <AutoRefresh intervalMs={3000} /> : null}
      <div>
        <div className="zf-k">{`${view.model.categoryCode === "RTU" ? "RTU" : "PLC"} · ${view.plc.name}`}</div>
        <h1 className="zf-h mt-1.5">Communication</h1>
      </div>
      <PlcCommunication
        view={communication}
        plc={{ name: view.plc.name }}
        actions={{
          create: createLinkAction.bind(null, factoryId, plcId),
          link: (linkId) => linkAction.bind(null, factoryId, plcId, linkId),
          addMapping: (linkId) => addMappingAction.bind(null, factoryId, plcId, linkId),
          mapping: (linkId, mappingId) => mappingAction.bind(null, factoryId, plcId, linkId, mappingId),
          linkFile: (linkId) => routes.plcLinkFile(factoryId, plcId, linkId),
          peerHref: (peerId) => routes.plcCommunication(factoryId, peerId),
        }}
      />
    </StoredPlcShell>
  );
}
