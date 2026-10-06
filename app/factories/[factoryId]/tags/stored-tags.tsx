import { LiveTagTable } from "@/components/live/live-tag-table";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { routes } from "@/lib/navigation/routes";
import { getLiveTags } from "@/lib/services/live-service";
import { getLiveDeps } from "@/lib/services/runtime-deps";
import { writeTagAction } from "../live-actions";
import { loadStoredFactory } from "../load-stored-factory";

/**
 * 2l for a stored factory: every tag of its PLCs with value, quality and age, live.
 * Values come from the tag monitor's memory and its stream, never from stored history.
 */
export async function StoredTags({ factoryId, plcId }: { factoryId: string; plcId?: string }) {
  const { actor, factory } = await loadStoredFactory(factoryId);
  const view = await getLiveTags(getLiveDeps(), actor, factory.id);
  const selected = view.plcs.find((plc) => plc.id === plcId);
  const tags = selected ? view.tags.filter((tag) => tag.plcId === selected.id) : view.tags;
  const monitored = view.plcs.filter((plc) => plc.monitored).length;

  return (
    <AppShell
      title={`Live Tags — ${factory.name}`}
      titleState={
        <StatePill tone={monitored > 0 ? "run" : "off"}>{`${monitored}/${view.plcs.length} PLCs read`}</StatePill>
      }
      activity="factories"
      sidebar={
        <SideBar title="Tags">
          <SideSection title="By PLC">
            <Tree
              items={[
                { label: "All PLCs", meta: view.tags.length, href: routes.tags(factory.id), active: !selected },
                ...view.plcs.map((plc) => ({
                  label: plc.name,
                  meta: plc.tagCount,
                  href: routes.tags(factory.id, plc.id),
                  active: plc.id === selected?.id,
                  level: 1 as const,
                })),
              ]}
            />
          </SideSection>
          <SideSection title="PLC runtimes">
            <div className="flex flex-col gap-1.5 px-4 py-2">
              {view.plcs.length === 0 ? <span className="zf-sub">This factory has no PLC yet.</span> : null}
              {view.plcs.map((plc) => (
                <span key={plc.id} className="flex items-center justify-between gap-2">
                  <a className="mono" href={routes.plcRuntime(factory.id, plc.id)}>
                    {plc.name}
                  </a>
                  <RuntimeStatePill state={plc.runtimeStatus} />
                </span>
              ))}
            </div>
          </SideSection>
          <SideSection title="Reading">
            <p className="zf-sub px-4 py-2">
              Values are read from each running PLC over Modbus and pushed here. A PLC that is not started has no
              values. Only command and setpoint tags can be written.
            </p>
          </SideSection>
        </SideBar>
      }
      status={{
        tone: monitored > 0 ? "ok" : "off",
        left: [`⎇ ${factory.slug}`, "live tags", `${tags.length} tags`],
        right: ["SSE"],
      }}
    >
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: "Live Tags", active: true },
          { label: "Events", href: routes.events(factory.id) },
        ]}
        crumb={`${factory.slug} › live tags${selected ? ` › ${selected.name.toLowerCase()}` : ""}`}
      />
      <Content plain>
        <div>
          <div className="zf-k">{`Factory · ${factory.slug}`}</div>
          <h1 className="zf-h mt-1.5">{selected ? `Live tags · ${selected.name}` : "Live tags"}</h1>
        </div>
        {view.plcs.length > 0 && monitored === 0 ? (
          <p className="zf-error" role="alert">
            No PLC of this factory is started, so there are no live values. Start a PLC from its Runtime screen.
          </p>
        ) : null}
        <LiveTagTable
          // Another PLC, or a changed tag list, starts the table again with the new rows.
          key={`${selected?.id ?? "all"}:${tags.length}`}
          rows={tags.map((tag) => ({
            plcId: tag.plcId,
            plcName: tag.plcName,
            name: tag.name,
            role: tag.role,
            authority: tag.authority,
            dataType: tag.dataType,
            unit: tag.unit,
            logicalAddress: tag.logicalAddress,
            deviceName: tag.deviceName,
            reading: tag.reading,
            write: tag.writable ? writeTagAction.bind(null, factory.id, tag.plcId, tag.name) : null,
          }))}
          streamUrl={routes.stream(factory.id)}
          staleAfterMs={view.staleAfterMs}
          showPlc={!selected && view.plcs.length > 1}
        />
      </Content>
    </AppShell>
  );
}
