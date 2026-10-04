import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs, Panel } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { Spark } from "@/components/ui/primitives";
import { StatePill, tagQualityTone } from "@/components/ui/state-pill";
import { isWritableTagRole, TAG_QUALITIES, type TagQuality } from "@/lib/domain/tag";
import { demoContext, isDemoFactory } from "@/lib/fixtures";
import { devices, factory, type LiveTag, liveTags, plc } from "@/lib/fixtures/pump-house-demo";

export const metadata: Metadata = { title: "Live tags" };

type TagsPageProps = {
  params: Promise<{ factoryId: string }>;
};

const QUALITY_SHORT: Record<TagQuality, string> = {
  GOOD: "GOOD",
  STALE: "STALE",
  BAD: "BAD",
  DISCONNECTED: "DISC",
};

function WriteCell({ tag, editing }: { tag: LiveTag; editing: boolean }) {
  if (!isWritableTagRole(tag.role)) return <span className="zf-k">read-only</span>;
  if (editing) return <span className="zf-k text-info">editing…</span>;
  return <Button size="sm">{tag.dataType === "BOOL" ? "Toggle" : "Write"}</Button>;
}

/** 2l — Live Tags: value · quality · timestamp, inline write with request/accept/actual. */
export default async function TagsPage({ params }: TagsPageProps) {
  const { factoryId } = await params;
  if (!isDemoFactory(factoryId)) notFound();

  const { tags, editing, lastWrite } = liveTags;
  const countByQuality = (quality: TagQuality) => tags.filter((tag) => tag.quality === quality).length;
  const peripherals = devices.filter((device) => device.kind !== "plc");

  return (
    <AppShell
      title={`Live Tags — ${factory.name}`}
      command="filter tag, device, role…"
      titleState={<StatePill tone="run">SSE</StatePill>}
      activity="tags"
      context={demoContext}
      badges={{ tags: tags.length }}
      sidebar={
        <SideBar title="Tags">
          <SideSection title="By device">
            <Tree
              items={[
                { label: "All", meta: tags.length, active: true },
                { label: plc.name, meta: tags.length, level: 1 },
                ...peripherals.map((device) => ({
                  label: device.name,
                  meta: tags.filter((tag) => tag.device === device.name).length,
                  level: 2 as const,
                })),
              ]}
            />
          </SideSection>
          <SideSection title="Quality">
            <div className="zf-chips">
              {TAG_QUALITIES.map((quality) => (
                <StatePill key={quality} tone={tagQualityTone(quality)}>
                  {`${QUALITY_SHORT[quality]} ${countByQuality(quality)}`}
                </StatePill>
              ))}
            </div>
          </SideSection>
        </SideBar>
      }
      status={{
        left: [`${tags.length} tags`, `GOOD ${countByQuality("GOOD")} · STALE ${countByQuality("STALE")}`],
        right: [liveTags.transport],
      }}
    >
      <EditorTabs tabs={[{ label: "Live Tags", active: true }, { label: "Trends" }]} crumb={liveTags.poll} />
      <Content plain flush>
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Role</th>
              <th>Type</th>
              <th>Value</th>
              <th>Trend 60 s</th>
              <th>Quality</th>
              <th>Upd.</th>
              <th>Write</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => {
              const isEditing = tag.name === editing.tag;
              const stale = tag.quality !== "GOOD";
              return (
                <tr key={tag.name} aria-selected={isEditing}>
                  <td className="mono syn-var">{tag.name}</td>
                  <td>{tag.role}</td>
                  <td className="mono syn-type">{tag.dataType}</td>
                  <td>
                    {isEditing ? (
                      <div className="flex items-center gap-1.5">
                        <div className="zf-in mono w-14" data-state="focus" data-size="sm">
                          {editing.draft}
                        </div>
                        <Button size="sm" variant="primary">
                          Write
                        </Button>
                      </div>
                    ) : (
                      <span className={stale ? "mono font-bold text-warn-fg" : "mono font-bold text-fg-strong"}>
                        {tag.value}
                      </span>
                    )}
                  </td>
                  <td>
                    <Spark trend={tag.trend} tone={stale ? "warn" : tag.role === "ALARM" ? "idle" : "info"} />
                  </td>
                  <td>
                    <StatePill tone={tagQualityTone(tag.quality)}>{QUALITY_SHORT[tag.quality]}</StatePill>
                  </td>
                  <td className={stale ? "mono text-warn-fg" : "mono"}>{tag.age}</td>
                  <td>
                    <WriteCell tag={tag} editing={isEditing} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Content>
      <Panel tabs={[`Last write · ${lastWrite.tag}`]} active={`Last write · ${lastWrite.tag}`}>
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {lastWrite.stages.map((stage) => (
            <StatePill key={stage.label} tone={stage.tone}>
              {stage.label}
            </StatePill>
          ))}
        </div>
      </Panel>
    </AppShell>
  );
}
