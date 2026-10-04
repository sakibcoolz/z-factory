import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EditFactoryPage from "@/app/factories/[factoryId]/edit/page";
import FactoryPage from "@/app/factories/[factoryId]/page";
import FactoriesLoading from "@/app/factories/loading";
import NewFactoryPage from "@/app/factories/new/page";
import FactoriesPage from "@/app/factories/page";
import { DeleteFactory } from "@/components/factories/delete-factory";
import { FactoryForm, slugify } from "@/components/factories/factory-form";
import { DomainError } from "@/lib/domain/errors";
import { RUNTIME_STATES, runtimeStateLabel } from "@/lib/domain/runtime-state";
import type { FactoryFormState } from "@/lib/factories/form-state";
import type { FactoryView } from "@/lib/services/factory-service";

const service = vi.hoisted(() => ({
  listFactories: vi.fn(),
  getFactory: vi.fn(),
  suggestFactorySubnet: vi.fn(),
  createFactory: vi.fn(),
  updateFactory: vi.fn(),
  deleteFactory: vi.fn(),
}));
const actor = vi.hoisted(() => ({ requireActor: vi.fn() }));

vi.mock("@/lib/services/factory-service", () => service);
vi.mock("@/lib/auth/actor", () => actor);
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

const FACTORY_ID = "01a107ff-de99-71ec-adbb-40049a4cf552";

const factory = (overrides: Partial<FactoryView> = {}): FactoryView => ({
  id: FACTORY_ID,
  name: "Pump House",
  slug: "pump-house",
  description: "Booster station",
  status: "DRAFT",
  runtimeStatus: "STOPPED",
  dockerNetworkName: `zfactory_${FACTORY_ID}`,
  subnetCidr: "172.20.1.0/24",
  deviceCount: 6,
  plcCount: 1,
  lastEvent: { type: "FACTORY_CREATED", occurredAt: "2026-10-04T17:20:23.000Z" },
  createdAt: "2026-10-04T17:20:23.000Z",
  updatedAt: "2026-10-04T17:20:23.000Z",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  actor.requireActor.mockResolvedValue({ ownerId: "owner-1" });
  service.listFactories.mockResolvedValue([factory()]);
  service.getFactory.mockResolvedValue(factory());
  service.suggestFactorySubnet.mockResolvedValue("172.20.2.0/24");
});

describe("2a factories list", () => {
  it("lists the owner's factories from the service", async () => {
    render(await FactoriesPage());

    expect(actor.requireActor).toHaveBeenCalled();
    expect(service.listFactories).toHaveBeenCalledWith(expect.anything(), { ownerId: "owner-1" });
    const row = within(screen.getByRole("table")).getByText("Pump House").closest("tr") as HTMLElement;
    expect(within(row).getByText("172.20.1.0/24")).toBeInTheDocument();
    expect(within(row).getByText("FACTORY_CREATED · 2026-10-04 17:20 UTC")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Open" })).toHaveAttribute("href", `/factories/${FACTORY_ID}`);
    expect(screen.getByRole("link", { name: "+ New factory" })).toHaveAttribute("href", "/factories/new");
  });

  it("shows a distinct pill for every runtime state", async () => {
    render(await FactoriesPage());

    const tones = RUNTIME_STATES.map((state) => {
      const pills = screen.getAllByText(runtimeStateLabel(state), { selector: ".zf-st" });
      return pills[0]?.getAttribute("data-tone");
    });
    expect(tones.every(Boolean)).toBe(true);
    // STARTING and STOPPING share the transitional tone by design; the rest are unique.
    expect(new Set(tones).size).toBe(RUNTIME_STATES.length - 1);
  });

  it("disables factory-scoped activities and makes no Docker claim", async () => {
    render(await FactoriesPage());

    const activities = within(screen.getByRole("navigation", { name: "Activities" }));
    expect(activities.getByLabelText("Factories")).toHaveAttribute("aria-current", "page");
    expect(activities.getByLabelText("Designer")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("phase 02").length).toBeGreaterThan(0);
  });

  it("propagates an authorization failure instead of rendering data", async () => {
    actor.requireActor.mockRejectedValue(new DomainError("UNAUTHORIZED", "No owner is configured."));

    await expect(FactoriesPage()).rejects.toThrow("No owner is configured.");
    expect(service.listFactories).not.toHaveBeenCalled();
  });
});

describe("2b first run", () => {
  it("shows the welcome screen when the owner has no factories", async () => {
    service.listFactories.mockResolvedValue([]);
    render(await FactoriesPage());

    expect(screen.getByRole("heading", { name: "Build a virtual plant." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New factory…/ })).toHaveAttribute("href", "/factories/new");
    expect(screen.getByText("no factories yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("loading state", () => {
  it("announces that factories are loading", () => {
    render(<FactoriesLoading />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading factories…");
  });
});

describe("2c create factory", () => {
  it("offers a free subnet and no slug until a name is typed", async () => {
    render(await NewFactoryPage());

    expect(screen.getByRole("heading", { name: "Create factory" })).toBeInTheDocument();
    expect(screen.getByLabelText("Subnet")).toHaveValue("172.20.2.0/24");
    expect(screen.getByLabelText("Slug")).toHaveValue("");
  });

  it("derives the slug from the name until the slug is edited", async () => {
    render(await NewFactoryPage());

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pump House Demo" } });
    expect(screen.getByLabelText("Slug")).toHaveValue("pump-house-demo");

    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    expect(screen.getByLabelText("Slug")).toHaveValue("custom");
  });

  it("slugifies names into URL-safe slugs", () => {
    expect(slugify("  Pump House — Demo #1 ")).toBe("pump-house-demo-1");
    expect(slugify("ÄÖ")).toBe("");
  });
});

describe("factory form", () => {
  const initial = { name: "Pump House", slug: "pump-house", description: "", subnetCidr: "8.8.8.0/24" };

  it("shows field errors returned by the action and keeps the input", async () => {
    const action = vi.fn(async (_state: FactoryFormState, formData: FormData): Promise<FactoryFormState> => ({
      fieldErrors: { subnetCidr: "Use a private range (10/8, 172.16/12 or 192.168/16)." },
      values: { ...initial, subnetCidr: String(formData.get("subnetCidr")) },
    }));
    render(<FactoryForm mode="create" action={action} initial={initial} cancelHref="/factories" />);

    fireEvent.click(screen.getByRole("button", { name: "Create factory" }));

    const subnet = await screen.findByLabelText("Subnet");
    await waitFor(() => expect(subnet).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByRole("alert")).toHaveTextContent("Use a private range");
    expect(subnet).toHaveValue("8.8.8.0/24");
    expect(action.mock.calls[0]?.[1].get("name")).toBe("Pump House");
  });

  it("shows a form-level message when the failure has no field", async () => {
    const action = async (): Promise<FactoryFormState> => ({
      message: "Something went wrong. Nothing was saved; try again.",
      fieldErrors: {},
      values: initial,
    });
    render(<FactoryForm mode="create" action={action} initial={initial} cancelHref="/factories" />);

    fireEvent.click(screen.getByRole("button", { name: "Create factory" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was saved");
  });

  it("locks the slug when editing", () => {
    render(<FactoryForm mode="edit" action={vi.fn()} initial={initial} cancelHref="/factories/x" networkName="zf_x" />);

    expect(screen.getByLabelText("Slug · fixed at creation")).toHaveAttribute("readonly");
    expect(screen.getByText("zf_x")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });
});

describe("factory view and edit", () => {
  const params = Promise.resolve({ factoryId: FACTORY_ID });

  it("shows configuration and last persisted runtime state separately", async () => {
    render(await FactoryPage({ params }));

    expect(screen.getByRole("heading", { name: "Pump House" })).toBeInTheDocument();
    expect(screen.getByText("configuration draft")).toBeInTheDocument();
    expect(screen.getByText("6 devices · 1 PLCs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", `/factories/${FACTORY_ID}/edit`);
  });

  it("answers unknown, foreign and malformed ids with not-found", async () => {
    service.getFactory.mockRejectedValue(new DomainError("NOT_FOUND", "The factory does not exist."));
    await expect(FactoryPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");

    await expect(FactoryPage({ params: Promise.resolve({ factoryId: "not-a-uuid" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(service.getFactory).toHaveBeenCalledTimes(1);
  });

  it("sends the design-fixture factory to its designer", async () => {
    await expect(FactoryPage({ params: Promise.resolve({ factoryId: "factory_001" }) })).rejects.toThrow(
      "NEXT_REDIRECT /factories/factory_001/designer",
    );
  });

  it("prefills the edit form", async () => {
    render(await EditFactoryPage({ params }));

    expect(screen.getByLabelText("Name")).toHaveValue("Pump House");
    expect(screen.getByLabelText("Subnet")).toHaveValue("172.20.1.0/24");
    expect(screen.getByLabelText("Description")).toHaveValue("Booster station");
  });
});

describe("delete factory", () => {
  it("asks before deleting and shows the failure reason", async () => {
    const action = vi.fn(async () => ({ message: "Stop the factory before deleting it." }));
    render(<DeleteFactory factoryName="Pump House" action={action} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Delete Pump House and its devices?");

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Stop the factory before deleting it."));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled", () => {
    render(<DeleteFactory factoryName="Pump House" action={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
