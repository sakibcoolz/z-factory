import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs, Panel, Toolbar } from "@/components/shell/editor";
import { SideBar, SideSection } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { KeyValue, Log, StepList } from "@/components/ui/primitives";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { demoContext, isDemoFactory } from "@/lib/fixtures";
import { host } from "@/lib/fixtures/factories";
import { factory, runtime } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";

export const metadata: Metadata = { title: "Runtime" };

type RuntimePageProps = {
  params: Promise<{ factoryId: string }>;
};

const monoRows = (rows: ReadonlyArray<readonly [string, string]>) =>
  rows.map(
    ([label, value]) =>
      [
        label,
        <span key="v" className="mono">
          {value}
        </span>,
      ] as const,
  );

/** 2n — Runtime / Containers: Docker lifecycle per factory. Shows service names, never Docker IDs. */
export default async function RuntimePage({ params }: RuntimePageProps) {
  const { factoryId } = await params;
  if (!isDemoFactory(factoryId)) notFound();

  const { services, summary } = runtime;
  const external = services.filter((service) => service.state === "DISCONNECTED").length;
  const primaryService = services[0];

  return (
    <AppShell
      title={`Runtime — ${factory.name}`}
      command={`${factory.network.name} · ${factory.network.subnet}`}
      titleState={<RuntimeStatePill state={runtime.state} />}
      activity="runtime"
      context={demoContext}
      sidebar={
        <SideBar title="Runtime">
          <SideSection title="Network">
            <KeyValue rows={monoRows(runtime.network)} />
          </SideSection>
          <SideSection title="Lifecycle">
            <StepList steps={runtime.lifecycle} dense />
          </SideSection>
          <SideSection title="Limits">
            <KeyValue rows={monoRows(runtime.limits)} />
          </SideSection>
        </SideBar>
      }
      status={{
        tone: "deg",
        left: [runtime.state, `${summary.healthy}/${summary.total} containers healthy`],
        right: [`Docker ${host.dockerEngine}`, "dockerode"],
      }}
    >
      <EditorTabs
        tabs={[
          { label: "Containers", active: true },
          { label: "Simulator", href: routes.simulator(factoryId) },
        ]}
        crumb="image allow-list · digests recorded"
      />
      <Toolbar summary={`uptime ${runtime.uptime} · ${services.length - external} containers · ${external} external`}>
        <Button size="sm" variant="ghost">
          Restart all
        </Button>
        <Button size="sm" variant="danger">
          Stop factory
        </Button>
      </Toolbar>
      <Content plain flush className="flex-none">
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Service</th>
              <th>Image</th>
              <th>Container</th>
              <th>IP · ports</th>
              <th>Health</th>
              <th>CPU · mem</th>
              <th>State</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {services.map((service) => (
              <tr key={service.service}>
                <td>
                  <b className="text-fg-strong">{service.service}</b>
                  <div className="mono text-fg-dim">{service.detail}</div>
                </td>
                <td className="mono">
                  {service.image}
                  {service.imageDigest ? <div className="text-fg-dim">{service.imageDigest}</div> : null}
                </td>
                <td className="mono">{service.container}</td>
                <td className="mono">
                  {service.address}
                  {service.hostPort ? <div className="text-fg-dim">{service.hostPort}</div> : null}
                </td>
                <td>
                  <StatePill tone={service.health.tone}>{service.health.label}</StatePill>
                </td>
                <td className="mono">{service.usage}</td>
                <td>
                  <RuntimeStatePill state={service.state} />
                </td>
                <td>
                  {service.action ? (
                    <Button size="sm" variant={service.action.primary ? "default" : "ghost"}>
                      {service.action.label}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Content>
      <Panel
        grow
        tabs={[`Logs · ${primaryService?.service ?? ""}`, "device-simulator", "Docker events"]}
        active={`Logs · ${primaryService?.service ?? ""}`}
        end={
          <div className="zf-in w-40" data-size="sm">
            filter…
          </div>
        }
      >
        <Log rows={runtime.logs} />
      </Panel>
    </AppShell>
  );
}
