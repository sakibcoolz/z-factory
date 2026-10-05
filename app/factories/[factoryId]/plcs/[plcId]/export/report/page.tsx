import type { Metadata } from "next";
import { PlcReport } from "@/components/export/plc-report";
import { PrintButton } from "@/components/export/print-button";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/navigation/routes";
import { buildPlcExport } from "@/lib/services/plc-export-service";
import { loadPlc } from "../../load-plc";

export const metadata: Metadata = { title: "PLC engineering report" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

type ReportPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
  searchParams: Promise<{ runtime?: string | string[] }>;
};

/** 2p — the engineering report on its own page, without the application shell, for printing. */
export default async function ReportPage({ params, searchParams }: ReportPageProps) {
  const { factoryId, plcId } = await params;
  const runtime = (await searchParams).runtime === "1";
  const { actor, db } = await loadPlc(factoryId, plcId);
  const document = await buildPlcExport(db, actor, plcId, { includeRuntime: runtime });

  return (
    <main className="zf-report-page">
      <div className="zf-report-actions">
        <PrintButton />
        <Button variant="ghost" href={routes.plcExport(factoryId, plcId)}>
          Back to export
        </Button>
        <span className="zf-k ml-auto">{`A4 / Letter · rev ${document.revision.configuration}`}</span>
      </div>
      <PlcReport document={document} />
    </main>
  );
}
