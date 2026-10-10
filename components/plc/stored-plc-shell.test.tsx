import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildPlcContext } from "@/lib/agent/contexts/plc";
import type { PlcConfigurationView } from "@/lib/domain/plc-config-view";
import { StoredPlcShell } from "./stored-plc-shell";

const F = "01a10a0d-e48d-744e-ba58-dfb344f7e880";
const P = "01a10a0d-e48d-744e-ba58-dfb344f7e883";

const view: PlcConfigurationView = {
  plc: {
    id: P,
    factoryId: F,
    name: "PLC-01",
    role: null,
    runtimeStatus: "STOPPED",
    architectureType: "COMPACT",
    ioMappingVersion: 0,
    modbusMappingVersion: 0,
  },
  model: {
    id: "model-1",
    manufacturer: "Generic / simulated",
    family: "Generic PLC",
    modelName: "Generic compact PLC",
    sku: null,
    verificationStatus: "GENERIC",
    categoryCode: "PLC",
    capabilities: ["PROGRAMMABLE"],
    runtimeSupport: "OPENPLC",
  },
  electrical: null,
  ports: [],
  rack: null,
  banks: [],
  occupancy: { total: 0, occupied: 0 },
  peripherals: [],
};

describe("the stored PLC shell", () => {
  it("renders the screen's LLM Context after its content, and nothing when none is given", () => {
    const { unmount } = render(
      <StoredPlcShell factory={{ id: F, name: "Pump House" }} view={view} section="overview">
        <p>the overview</p>
      </StoredPlcShell>,
    );
    expect(screen.getByText("the overview")).toBeInTheDocument();
    expect(document.querySelector("details[data-llm-context]")).toBeNull();
    unmount();

    render(
      <StoredPlcShell
        factory={{ id: F, name: "Pump House" }}
        view={view}
        section="overview"
        llmContext={buildPlcContext({ factory: { id: F, name: "Pump House" }, view, section: "overview" })}
      >
        <p>the overview</p>
      </StoredPlcShell>,
    );
    const panel = document.querySelector("details[data-llm-context]") as HTMLElement;
    expect(panel).toHaveAttribute("data-llm-context", "plc");
    expect(panel).toHaveAttribute("data-llm-page", "PLC overview");
    // The content comes first, the panel last.
    expect(
      screen.getByText("the overview").compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const validation = within(within(panel).getByRole("region", { name: "Validation state" }));
    expect(validation.getByText("Nothing is wired to this PLC")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Hardware" })).toHaveAttribute(
      "href",
      `/factories/${F}/plcs/${P}/hardware`,
    );
  });
});
