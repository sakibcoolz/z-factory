import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/navigation/routes";

export default function NotFound() {
  return (
    <AppShell title="Z-FACTORY" activity="factories" status={{ tone: "off", left: ["not found"] }}>
      <EditorTabs tabs={[{ label: "Not found", active: true }]} />
      <Content plain>
        <div>
          <div className="zf-k">404</div>
          <h1 className="zf-h mt-1.5">Nothing here yet</h1>
          <p className="zf-sub mt-1.5 max-w-90">
            This factory or device has no screen yet. Only the Pump House Demo is available while the app renders design
            fixtures.
          </p>
        </div>
        <div>
          <Button variant="primary" href={routes.factories()}>
            Back to factories
          </Button>
        </div>
      </Content>
    </AppShell>
  );
}
