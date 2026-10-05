import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import type { PlcBankView, PlcPointView } from "@/lib/domain/plc-config-view";
import { type ActionState, readForm, toActionState } from "@/lib/plc/form-state";
import { ModuleInstallForm } from "./module-install-form";
import { PinDetails, PinView } from "./pin-view";
import { PlcCreateForm } from "./plc-create-form";

const noop = async (state: ActionState) => state;

const point = (overrides: Partial<PlcPointView>): PlcPointView => ({
  id: "p0",
  ioType: "DI",
  label: "Ia.0",
  vendorAddress: "%I0.0",
  logicalAddress: "%MX0.0",
  signalTypes: ["DC_24V"],
  status: "FREE",
  device: null,
  tagName: null,
  ...overrides,
});

describe("PLC form state", () => {
  it("reads only the named fields and tolerates missing ones", () => {
    const data = new FormData();
    data.set("name", "PLC-01");
    data.set("other", "x");
    expect(readForm(data, ["name", "role"])).toEqual({ name: "PLC-01", role: "" });
  });

  it("puts a known cause on its field and anything else in the form message", () => {
    const values = { name: "PLC-01", slotIndex: "2" };
    expect(
      toActionState(new DomainError("VALIDATION", "Bad slot.", { field: "slotIndex" }), values).fieldErrors,
    ).toEqual({
      slotIndex: "Bad slot.",
    });
    expect(
      toActionState(
        new DomainError("VALIDATION", "Invalid input", { issues: [{ path: "name", message: "Too long." }] }),
        values,
      ).fieldErrors,
    ).toEqual({ name: "Too long." });
    expect(
      toActionState(
        new DomainError("CONFLICT", "duplicate", { constraint: "DeviceInstance_factoryId_name_key" }),
        values,
      ).fieldErrors,
    ).toEqual({ name: "A device with this name already exists in this factory." });
    // A field the form does not have falls back to the form message.
    expect(
      toActionState(new DomainError("NOT_FOUND", "The factory does not exist.", { field: "factoryId" }), values),
    ).toMatchObject({
      message: "The factory does not exist.",
      fieldErrors: {},
    });
    // Internal failures never reach the browser.
    expect(toActionState(new Error("connection refused 10.0.0.5"), values).message).toBe(
      "Something went wrong. Nothing was saved; try again.",
    );
  });
});

describe("PLC create form", () => {
  const models = [
    {
      id: "m1",
      manufacturer: "Siemens",
      family: "SIMATIC S7-1200",
      modelName: "CPU 1214C DC/DC/DC",
      sku: "6ES7214-1AG40-0XB0",
      verificationStatus: "VERIFIED",
      io: "14 DI · 10 DO · 2 AI",
      ports: "PROFINET ×1",
    },
    {
      id: "m2",
      manufacturer: "Schneider Electric",
      family: "Modicon M241",
      modelName: "TM241CE24T",
      sku: "TM241CE24T",
      verificationStatus: "VERIFIED",
      io: "14 DI · 10 DO",
      ports: "Ethernet ×1",
    },
  ];

  it("offers the catalog models of the chosen architecture with name and separate role", () => {
    render(
      <PlcCreateForm
        action={noop}
        architecture="compact"
        models={models}
        suggestedName="PLC-02"
        cancelHref="/factories/f"
      />,
    );

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(screen.getByText("Siemens SIMATIC S7-1200 CPU 1214C DC/DC/DC")).toBeInTheDocument();
    expect(screen.getByText("6ES7214-1AG40-0XB0 · 14 DI · 10 DO · 2 AI · PROFINET ×1")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("PLC-02");
    expect(screen.getByLabelText("Process role")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Create PLC" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/factories/f");
  });

  it("cannot be submitted when the catalog has no model for the architecture", () => {
    render(<PlcCreateForm action={noop} architecture="modular" models={[]} suggestedName="PLC-01" cancelHref="/" />);
    expect(screen.getByRole("button", { name: "Create PLC" })).toBeDisabled();
  });
});

describe("module install form (modular path)", () => {
  const modules = [
    {
      id: "di",
      modelName: "DI 16x24VDC BA",
      sku: "6ES7521-1BH10-0AA0",
      moduleType: "DIGITAL_INPUT",
      channels: [{ ioType: "DI" as const, count: 16, signalType: "DC_24V", acceptedSignalTypes: [] }],
    },
    {
      id: "ai",
      modelName: "AI 8xU/I/RTD/TC ST",
      sku: "6ES7531-7KF00-0AB0",
      moduleType: "ANALOG_INPUT",
      channels: [
        { ioType: "AI" as const, count: 8, signalType: "CURRENT_4_20MA", acceptedSignalTypes: ["VOLTAGE_PM_10V"] },
      ],
    },
  ];

  it("lists only the compatible modules it was given and only free slots", () => {
    render(<ModuleInstallForm action={noop} modules={modules} freeSlots={[2, 3, 31]} />);
    const moduleSelect = within(screen.getByLabelText("Compatible module"));
    expect(moduleSelect.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "DI 16x24VDC BA · 16 × DI 24 V DC",
      "AI 8xU/I/RTD/TC ST · 8 × AI 4–20 mA",
    ]);
    expect(
      within(screen.getByLabelText("Slot"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["2", "3", "31"]);
    expect(screen.getByRole("button", { name: "Install module" })).toBeEnabled();
  });

  it("cannot install when every slot is in use", () => {
    render(<ModuleInstallForm action={noop} modules={modules} freeSlots={[]} />);
    expect(screen.getByRole("button", { name: "Install module" })).toBeDisabled();
    expect(screen.getByText("every slot is in use")).toBeInTheDocument();
  });
});

describe("pin view", () => {
  const banks: PlcBankView[] = [
    {
      key: "builtin-DI",
      label: "Digital inputs",
      ioType: "DI",
      slotIndex: null,
      points: [
        point({
          id: "p0",
          status: "OCCUPIED",
          device: { id: "d", name: "XV-101", terminalLabel: "ZSO" },
          tagName: "XV_101_ZSO",
        }),
        point({ id: "p1", label: "Ia.1", logicalAddress: "%MX0.1" }),
      ],
    },
    {
      key: "slot3-AI",
      label: "Slot 3 · AI 8xU/I/RTD/TC ST",
      ioType: "AI",
      slotIndex: 3,
      points: [point({ id: "p2", ioType: "AI", label: "0", logicalAddress: "%MW0", vendorAddress: null })],
    },
  ];

  it("draws one pin per I/O point with its state and a link that selects it", () => {
    render(<PinView banks={banks} selectedId="p1" pinHref={(id) => `/hw?pin=${id}`} />);

    expect(screen.getByText("DI · 1/2 used")).toBeInTheDocument();
    expect(screen.getByText("Slot 3 · AI 8xU/I/RTD/TC ST")).toBeInTheDocument();
    const occupied = screen.getByRole("link", { name: "DI Ia.0 · %MX0.0 · wired to XV-101" });
    expect(occupied).toHaveAttribute("data-state", "occupied");
    expect(occupied).toHaveAttribute("href", "/hw?pin=p0");
    const selected = screen.getByRole("link", { name: "DI Ia.1 · %MX0.1 · free" });
    expect(selected).toHaveAttribute("data-state", "selected");
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "AI 0 · %MW0 · free" })).toHaveAttribute("data-state", "free");
  });

  it("says what to do when a modular PLC has no module yet", () => {
    render(<PinView banks={[]} pinHref={() => "/"} />);
    expect(screen.getByText("No I/O yet. Install a module to get channels.")).toBeInTheDocument();
  });

  it("shows program address, vendor address, device and tag of the selected channel", () => {
    const first = banks[0]?.points[0];
    if (!first) throw new Error("fixture");
    render(<PinDetails point={first} />);
    expect(screen.getByText("DI Ia.0 · occupied")).toBeInTheDocument();
    expect(screen.getByText("%MX0.0")).toBeInTheDocument();
    expect(screen.getByText("%I0.0")).toBeInTheDocument();
    expect(screen.getByText("XV-101 · ZSO")).toBeInTheDocument();
    expect(screen.getByText("XV_101_ZSO")).toBeInTheDocument();
  });
});
