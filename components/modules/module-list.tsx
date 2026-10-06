import Link from "next/link";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import type { ModuleDetail } from "@/lib/domain/process-module-view";
import { routes } from "@/lib/navigation/routes";

/** Whether a module may run, as one pill: ready, or what is missing. */
export function ReadinessPill({ module }: { module: ModuleDetail }) {
  if (module.readyToRun) return <StatePill tone="run">ready to run</StatePill>;
  const missing = [
    module.issues.length > 0 ? `${module.issues.length} issue${module.issues.length === 1 ? "" : "s"}` : null,
    module.bindings.requiredUnbound > 0 ? `${module.bindings.requiredUnbound} required unbound` : null,
    module.bindings.invalid > 0 ? `${module.bindings.invalid} invalid` : null,
  ].filter(Boolean);
  return <StatePill tone={missing.length > 0 ? "deg" : "off"}>{missing.join(" · ") || "no process model"}</StatePill>;
}

/** The modules of a factory: type, profile, devices in roles, bindings and readiness. */
export function ModuleList({ factoryId, modules }: { factoryId: string; modules: ModuleDetail[] }) {
  if (modules.length === 0) {
    return (
      <p className="zf-sub">
        No process module yet. Create one from a type below; it composes devices the factory already has.
      </p>
    );
  }
  return (
    <table className="zf-tbl">
      <thead>
        <tr>
          <th>Module</th>
          <th>Type</th>
          <th>Profile</th>
          <th>Devices</th>
          <th>Signals bound</th>
          <th>Readiness</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {modules.map((module) => {
          const consumed =
            module.signalCounts.INPUT.required +
            module.signalCounts.INPUT.optional +
            module.signalCounts.OUTPUT.required +
            module.signalCounts.OUTPUT.optional +
            module.signalCounts.ALARM.required +
            module.signalCounts.ALARM.optional;
          return (
            <tr key={module.id}>
              <td className="mono">
                <Link href={routes.module(factoryId, module.id)}>{module.name}</Link>
                {module.location ? <span className="zf-sub block">{module.location}</span> : null}
              </td>
              <td className="mono">{`${module.type.code} v${module.type.version}`}</td>
              <td className="mono">{module.profile ?? "—"}</td>
              <td className="mono">{module.deviceCount}</td>
              <td className="mono">{`${module.bindings.bound} of ${consumed}`}</td>
              <td>
                <ReadinessPill module={module} />
              </td>
              <td>
                <RuntimeStatePill state={module.status} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
