import type { Metadata } from "next";
import Link from "next/link";
import { CatalogModelView } from "@/components/catalog/catalog-view";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree, type TreeNode } from "@/components/shell/side-bar";
import { StatePill } from "@/components/ui/state-pill";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import type { CatalogOverview } from "@/lib/domain/catalog-view";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { getCatalogModel, getCatalogOverview, listCompatiblePeripherals } from "@/lib/services/catalog-service";

export const metadata: Metadata = { title: "Device catalog" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Beside a model in the tree: whether it has a 3D asset. A model without one says nothing. */
const ASSET_MARK: Record<
  CatalogOverview["manufacturers"][number]["families"][number]["models"][number]["asset"]["state"],
  string | undefined
> = {
  READY: "3D",
  PENDING: "3D …",
  FAILED: "3D failed",
  NONE: undefined,
};

/** Vendor records first; the long list of generic models goes last. */
function vendorsFirst(overview: CatalogOverview): CatalogOverview["manufacturers"] {
  const isGeneric = (manufacturer: CatalogOverview["manufacturers"][number]) =>
    manufacturer.families.every((family) => family.models.every((model) => model.verificationStatus === "GENERIC"));
  return [...overview.manufacturers].sort((a, b) => Number(isGeneric(a)) - Number(isGeneric(b)));
}

function buildTree(overview: CatalogOverview, type: string | undefined, selectedId: string | undefined): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const manufacturer of vendorsFirst(overview)) {
    const families = manufacturer.families.filter((family) => !type || family.categoryCode === type);
    if (families.length === 0) continue;
    nodes.push({
      label: manufacturer.name,
      meta: String(families.reduce((count, family) => count + family.models.length, 0)),
    });
    for (const family of families) {
      // The category is chosen with the type filter; only a PLC family says how it is built.
      const architecture = family.models[0]?.architectureType?.toLowerCase();
      nodes.push({ label: family.name, meta: architecture, level: 1, muted: true });
      for (const model of family.models) {
        nodes.push({
          label: model.modelName,
          meta: ASSET_MARK[model.asset.state],
          level: 2,
          href: routes.catalog({ model: model.id, type }),
          active: model.id === selectedId,
        });
      }
    }
  }
  return nodes;
}

/** The model to show when none is selected: the first verified PLC, else the first model. */
function defaultModelId(overview: CatalogOverview, type: string | undefined): string | undefined {
  const models = vendorsFirst(overview).flatMap((manufacturer) =>
    manufacturer.families
      .filter((family) => !type || family.categoryCode === type)
      .flatMap((family) => family.models.map((model) => ({ ...model, categoryCode: family.categoryCode }))),
  );
  const plc = models.find((model) => model.categoryCode === "PLC" && model.verificationStatus === "VERIFIED");
  return (plc ?? models[0])?.id;
}

type CatalogPageProps = { searchParams: Promise<{ model?: string | string[]; type?: string | string[] }> };

/** 2e — Device Catalog: manufacturer › family › model, with verified sources. */
export default async function CatalogPage({ searchParams }: CatalogPageProps) {
  await requireActor();
  const db = getDb();
  const query = await searchParams;
  const overview = await getCatalogOverview(db);

  const requestedType = typeof query.type === "string" ? query.type : undefined;
  const type = overview.categories.some((category) => category.code === requestedType) ? requestedType : undefined;
  const requestedModel = typeof query.model === "string" && UUID.test(query.model) ? query.model : undefined;
  const selectedId = requestedModel ?? defaultModelId(overview, type);

  const model = selectedId
    ? await getCatalogModel(db, selectedId).catch((error: unknown) => {
        if (isDomainError(error, "NOT_FOUND")) return undefined;
        throw error;
      })
    : undefined;
  const peripherals = model?.categoryCode === "PLC" ? await listCompatiblePeripherals(db, model.id) : undefined;
  const { totals } = overview;

  return (
    <AppShell
      title="Device Catalog — Z-FACTORY"
      activity="catalog"
      sidebar={
        <SideBar title="Catalog">
          <SideSection title="Type">
            <div className="zf-chips">
              <Link href={routes.catalog()} aria-current={type ? undefined : "true"}>
                <StatePill tone={type ? "off" : "start"}>All</StatePill>
              </Link>
              {overview.categories.map((category) => (
                <Link
                  key={category.code}
                  href={routes.catalog({ type: category.code })}
                  aria-current={type === category.code ? "true" : undefined}
                  title={category.name}
                >
                  {/* The first part of the name is enough on a chip; the tree shows the rest. */}
                  <StatePill tone={type === category.code ? "start" : "off"}>{category.name.split(" / ")[0]}</StatePill>
                </Link>
              ))}
            </div>
          </SideSection>
          <SideSection title="Manufacturer">
            <Tree items={buildTree(overview, type, model?.id)} />
          </SideSection>
        </SideBar>
      }
      status={{
        tone: totals.models > 0 ? "ok" : "off",
        left: ["catalog", `${totals.models} models · ${totals.manufacturers} manufacturers`],
        right: [
          `${totals.verified} verified · ${totals.generic} generic`,
          `${totals.withAsset} of ${totals.models} with 3D asset`,
        ],
      }}
    >
      <EditorTabs
        tabs={[{ label: model?.modelName ?? "Catalog", active: true }]}
        crumb={model ? `catalog › ${model.manufacturer.toLowerCase()} › ${model.family.toLowerCase()}` : "catalog"}
      />
      <Content plain>
        {model ? (
          <CatalogModelView model={model} peripherals={peripherals} />
        ) : (
          <div>
            <h1 className="zf-h">{totals.models === 0 ? "The catalog is empty" : "Model not found"}</h1>
            <p className="zf-sub mt-2">
              {totals.models === 0
                ? "Run npm run db:seed to load the verified vendor records and the generic simulated models."
                : "Choose a model from the list."}
            </p>
          </div>
        )}
      </Content>
    </AppShell>
  );
}
