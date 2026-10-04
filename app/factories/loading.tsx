import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";

export default function FactoriesLoading() {
  return (
    <AppShell title="Z-FACTORY" activity="factories" status={{ tone: "off", left: ["loading…"] }}>
      <EditorTabs tabs={[{ label: "Factories", active: true }]} />
      <Content plain>
        <div role="status" aria-live="polite">
          <div className="zf-k">Workspace</div>
          <p className="zf-h mt-1.5">Loading factories…</p>
        </div>
      </Content>
    </AppShell>
  );
}
