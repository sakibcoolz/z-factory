import Link from "next/link";
import { type DockerHostStatus, dockerStatusLabel } from "@/components/factories/factory-explorer";
import { SectionRule } from "@/components/ui/primitives";
import { StatePill, type Tone } from "@/components/ui/state-pill";
import { routes } from "@/lib/navigation/routes";

const START_ACTIONS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "New factory…", href: routes.newFactory() },
  { label: "Browse device catalog", href: routes.catalog() },
];

type WelcomeProps = {
  docker: DockerHostStatus;
};

/** 2b — first run: shown in place of the factory list while the owner has no factories. */
export function Welcome({ docker }: WelcomeProps) {
  const hostChecks: ReadonlyArray<{ label: string; tone: Tone; status: string }> = [
    { label: "PostgreSQL", tone: "run", status: "connected" },
    { label: "Docker Engine", tone: docker.reachable ? "run" : "flt", status: dockerStatusLabel(docker) },
    { label: "OpenPLC image", tone: "off", status: "TASK-202" },
  ];

  return (
    <>
      <div>
        <div className="zf-k">Z-Factory</div>
        <h1 className="zf-h mt-1.5 text-hero">Build a virtual plant.</h1>
        <p className="mt-1.5 max-w-90 leading-normal text-fg-muted">
          Catalog PLC → OpenPLC runtime → VFD → motor → pump, with an external edge gateway closing the loop over Modbus
          TCP.
        </p>
      </div>
      <SectionRule>
        <span className="zf-k">Start</span>
      </SectionRule>
      <ul className="flex flex-col gap-2">
        {START_ACTIONS.map((action) => (
          <li key={action.label}>
            <Link href={action.href} className="text-info hover:underline">
              ▸ {action.label}
            </Link>
          </li>
        ))}
      </ul>
      <SectionRule>
        <span className="zf-k">Host checks</span>
      </SectionRule>
      <div className="grid max-w-180 grid-cols-3 gap-2">
        {hostChecks.map((check) => (
          <div key={check.label} className="zf-cell">
            <span className="zf-k">{check.label}</span>
            <StatePill tone={check.tone}>{check.status}</StatePill>
          </div>
        ))}
      </div>
    </>
  );
}
