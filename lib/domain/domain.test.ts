import { describe, expect, it } from "vitest";
import { runtimeStateTone, tagQualityTone } from "@/components/ui/state-pill";
import { routes } from "@/lib/navigation/routes";
import { RUNTIME_STATES, runtimeStateLabel } from "./runtime-state";
import { isWritableTagRole, TAG_QUALITIES, TAG_ROLES } from "./tag";

describe("runtime state", () => {
  it("defines the seven states from the design spec", () => {
    expect(RUNTIME_STATES).toEqual([
      "STOPPED",
      "STARTING",
      "RUNNING",
      "DEGRADED",
      "FAULTED",
      "STOPPING",
      "DISCONNECTED",
    ]);
  });

  it("labels states in sentence case", () => {
    expect(runtimeStateLabel("RUNNING")).toBe("Running");
    expect(runtimeStateLabel("DISCONNECTED")).toBe("Disconnected");
  });

  it("maps every state to a tone, reserving the fault tone for FAULTED", () => {
    expect(runtimeStateTone("RUNNING")).toBe("run");
    expect(runtimeStateTone("DEGRADED")).toBe("deg");
    expect(runtimeStateTone("STOPPED")).toBe("off");
    expect(runtimeStateTone("DISCONNECTED")).toBe("disc");
    expect(RUNTIME_STATES.filter((state) => runtimeStateTone(state) === "flt")).toEqual(["FAULTED"]);
  });
});

describe("tags", () => {
  it("treats only command and setpoint roles as writable", () => {
    expect(TAG_ROLES.filter(isWritableTagRole)).toEqual(["COMMAND", "SETPOINT"]);
  });

  it("maps every quality to a tone, with GOOD the only healthy one", () => {
    expect(TAG_QUALITIES.filter((quality) => tagQualityTone(quality) === "run")).toEqual(["GOOD"]);
  });
});

describe("routes", () => {
  it("builds factory- and PLC-scoped paths from Z-Factory ids", () => {
    expect(routes.designer("factory_001")).toBe("/factories/factory_001/designer");
    expect(routes.plcExport("factory_001", "dev_001")).toBe("/factories/factory_001/plcs/dev_001/export");
    expect(routes.newDevice("factory_003", "modular")).toBe("/factories/factory_003/devices/new/modular");
  });

  it("encodes ids so they cannot escape their path segment", () => {
    expect(routes.designer("a/b")).toBe("/factories/a%2Fb/designer");
  });
});
