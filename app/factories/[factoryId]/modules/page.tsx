import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LlmContextPanel } from "@/components/agent/llm-context";
import { NewModuleForm } from "@/components/modules/module-form";
import { ModuleList } from "@/components/modules/module-list";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SectionRule } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { buildModulesContext } from "@/lib/agent/contexts/factory-engineering";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { getModulesScreen } from "@/lib/services/module-designer-service";
import { createModuleAction } from "./actions";

export const metadata: Metadata = { title: "Process modules" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ModulesPageProps = { params: Promise<{ factoryId: string }> };

/** The process modules of a stored factory, and the form that creates one from a type. */
export default async function ModulesPage({ params }: ModulesPageProps) {
  const { factoryId } = await params;
  if (!UUID.test(factoryId)) notFound();
  const actor = await requireActor();
  const view = await getModulesScreen(getDb(), actor, factoryId).catch((error: unknown) => {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  });
  const ready = view.modules.filter((module) => module.readyToRun).length;
  const running = view.modules.filter((module) => module.status === "RUNNING").length;

  return (
    <AppShell
      title={`Process modules — ${view.factory.name}`}
      titleState={
        <StatePill tone={running > 0 ? "run" : ready > 0 ? "start" : "off"}>
          {running > 0 ? `${running} running` : ready > 0 ? `${ready} ready` : "none ready"}
        </StatePill>
      }
      activity="factories"
      status={{
        tone: running > 0 ? "ok" : "off",
        left: ["process modules", `${view.modules.length} modules · ${ready} ready to run`],
        right: [`${view.types.length} types`],
      }}
    >
      <EditorTabs
        tabs={[
          { label: view.factory.name, href: routes.factory(view.factory.id) },
          { label: "Process modules", active: true },
          { label: "Runtime", href: routes.runtime(view.factory.id) },
          { label: "Events", href: routes.events(view.factory.id, { family: "PROCESS" }) },
        ]}
        crumb="a module composes devices the factory already has; its signals are bound to PLC tags"
      />
      <Content plain>
        <div>
          <div className="zf-k">{`Factory · ${view.factory.name}`}</div>
          <h1 className="zf-h mt-1.5">Process modules</h1>
        </div>
        <ModuleList factoryId={view.factory.id} modules={view.modules} />
        <SectionRule>
          <span className="zf-k">New module</span>
        </SectionRule>
        <NewModuleForm types={view.types} action={createModuleAction.bind(null, view.factory.id)} />
        <p className="zf-sub mt-auto">
          Module types are generic templates shipped with Z-Factory: they name device categories and logical signals,
          never a manufacturer&apos;s hardware. Nothing here changes a device.
        </p>
        <LlmContextPanel document={buildModulesContext(view)} />
      </Content>
    </AppShell>
  );
}
