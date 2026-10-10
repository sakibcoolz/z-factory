import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LlmContextPanel } from "@/components/agent/llm-context";
import { DeleteModule } from "@/components/modules/delete-module";
import { MODULE_SECTIONS, ModuleEditor } from "@/components/modules/module-editor";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { buildModuleEditorContext } from "@/lib/agent/contexts/factory-engineering";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { getModuleDesigner } from "@/lib/services/module-designer-service";
import { getProcessBridgeDeps } from "@/lib/services/runtime-deps";
import {
  deleteModuleAction,
  importModuleIoAction,
  moduleDeviceAction,
  moduleInterlockAction,
  moduleSignalAction,
  overrideAction,
  processBridgeAction,
  updateModuleAction,
} from "./actions";

export const metadata: Metadata = { title: "Process module" };

// Reads the database and the bridge of this server process on every request.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ModulePageProps = { params: Promise<{ factoryId: string; moduleId: string }> };

/** One process module: settings, roles, the consumed PLC I/O registry with its picker, interlocks, runtime, topology, export. */
export default async function ModulePage({ params }: ModulePageProps) {
  const { factoryId, moduleId } = await params;
  if (!UUID.test(factoryId) || !UUID.test(moduleId)) notFound();
  const actor = await requireActor();
  const view = await getModuleDesigner(getDb(), actor, moduleId, getProcessBridgeDeps()).catch((error: unknown) => {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  });
  if (view.factory.id !== factoryId) notFound();
  const { module, registry, runtime } = view;
  const bind = <Args extends unknown[], Result>(
    action: (factoryId: string, moduleId: string, ...args: Args) => Result,
  ) => action.bind(null, factoryId, moduleId);

  return (
    <AppShell
      title={`${module.name} — ${view.factory.name}`}
      titleState={<RuntimeStatePill state={module.status} />}
      activity="factories"
      sidebar={
        <SideBar title={module.name}>
          <SideSection title="Module">
            <Tree
              items={MODULE_SECTIONS.map((section) => ({
                label: section.label,
                href: `#${section.key}`,
                meta:
                  section.key === "registry"
                    ? `${registry.counts.INPUT.bound + registry.counts.OUTPUT.bound + registry.counts.ALARM.bound}/${registry.rows.length}`
                    : section.key === "roles"
                      ? String(module.deviceCount)
                      : section.key === "interlocks"
                        ? String(module.interlocks.length)
                        : undefined,
              }))}
            />
          </SideSection>
          <SideSection title="Instance">
            <KeyValue
              rows={[
                ["Type", `${view.type.code} v${view.type.version}`],
                ["Profile", module.profile ?? "—"],
                ["Location", module.location ?? "—"],
                ["Model", view.type.simulatorModelType ?? "none"],
              ]}
            />
          </SideSection>
          <SideSection title="Danger zone">
            <div className="p-3">
              <DeleteModule moduleName={module.name} action={deleteModuleAction.bind(null, factoryId, moduleId)} />
            </div>
          </SideSection>
        </SideBar>
      }
      status={{
        tone: module.status === "RUNNING" ? "ok" : module.readyToRun ? "off" : "deg",
        left: [module.name, module.readyToRun ? "ready to run" : "not ready"],
        right: [`${registry.plcs.length} PLCs`, `${module.deviceCount} devices`],
      }}
    >
      {runtime.bridgeRunning ? <AutoRefresh intervalMs={2000} /> : null}
      <EditorTabs
        tabs={[
          { label: view.factory.name, href: routes.factory(factoryId) },
          { label: "Process modules", href: routes.modules(factoryId) },
          { label: module.name, active: true },
        ]}
        crumb={`${view.factory.name.toLowerCase()} › process modules › ${module.name.toLowerCase()}`}
      />
      <Content plain>
        <ModuleEditor
          view={view}
          actions={{
            update: bind(updateModuleAction),
            device: bind(moduleDeviceAction),
            signal: bind(moduleSignalAction),
            interlock: bind(moduleInterlockAction),
            importIo: bind(importModuleIoAction),
            bridge: bind(processBridgeAction),
            override: (signal) => overrideAction.bind(null, factoryId, moduleId, signal),
          }}
        />
        <LlmContextPanel document={buildModuleEditorContext(view)} />
      </Content>
    </AppShell>
  );
}
