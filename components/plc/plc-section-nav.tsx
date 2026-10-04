import { Tree } from "@/components/shell/side-bar";
import { plcSections } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";

type PlcSectionKey = NonNullable<(typeof plcSections)[number]["key"]>;

const sectionHref = (key: PlcSectionKey, factoryId: string, plcId: string): string => {
  switch (key) {
    case "overview":
      return routes.plc(factoryId, plcId);
    case "program":
      return routes.plcProgram(factoryId, plcId);
    case "io-mapping":
      return routes.plcIoMapping(factoryId, plcId);
    case "export":
      return routes.plcExport(factoryId, plcId);
    case "simulator":
      return routes.simulator(factoryId);
    case "tags":
      return routes.tags(factoryId);
    case "events":
      return routes.events(factoryId);
    case "runtime":
      return routes.runtime(factoryId);
  }
};

type PlcSectionNavProps = {
  factoryId: string;
  plcId: string;
  active: PlcSectionKey;
};

/** PLC edit sections (docs/design.md → PLC edit). Sections without a screen yet are listed but not linked. */
export function PlcSectionNav({ factoryId, plcId, active }: PlcSectionNavProps) {
  return (
    <Tree
      items={plcSections.map((section) => ({
        label: section.label,
        meta: section.meta,
        muted: section.muted,
        active: section.key === active,
        href: section.key ? sectionHref(section.key, factoryId, plcId) : undefined,
      }))}
    />
  );
}
