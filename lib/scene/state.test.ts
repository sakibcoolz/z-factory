import { describe, expect, it } from "vitest";
import type { LiveDeviceState } from "@/lib/domain/live";
import { RUNTIME_STATES, type RuntimeState, runtimeStateTone } from "@/lib/domain/runtime-state";
import { edgeTone } from "@/lib/topology/flow";
import { connectionAppearance, type DeviceAppearance, deviceAppearance, sceneIsAnimated } from "./state";

const live = (status: RuntimeState, quality: LiveDeviceState["quality"] = "GOOD") => ({ status, quality });
const shown = (status: RuntimeState, quality?: LiveDeviceState["quality"]) =>
  deviceAppearance("STOPPED", live(status, quality), true);

describe("device appearance", () => {
  it("shows a confirmed state with the tone the pills and the 2D topology use", () => {
    for (const status of RUNTIME_STATES) {
      const appearance = shown(status);
      expect(appearance.tone, status).toBe(runtimeStateTone(status));
      expect(appearance).toMatchObject({ status, live: true });
    }
    expect(shown("RUNNING")).toEqual({ status: "RUNNING", tone: "run", label: "Running", live: true, pulse: false });
    expect(shown("FAULTED")).toEqual({ status: "FAULTED", tone: "flt", label: "Faulted", live: true, pulse: true });
    expect(shown("DEGRADED")).toMatchObject({ tone: "deg", label: "Degraded" });
    expect(shown("DISCONNECTED")).toMatchObject({ tone: "disc" });
  });

  it("keeps stopped, starting and stopping apart from running and from a fault", () => {
    expect(shown("STOPPED")).toMatchObject({ tone: "off", pulse: false });
    expect(shown("STARTING")).toMatchObject({ tone: "start", label: "Starting", pulse: false });
    expect(shown("STOPPING")).toMatchObject({ tone: "start", label: "Stopping" });
    for (const status of ["STOPPED", "STARTING", "STOPPING"] as const) {
      expect(["run", "flt"]).not.toContain(shown(status).tone);
    }
  });

  it("takes the live state over the one the page was rendered with", () => {
    expect(deviceAppearance("RUNNING", live("FAULTED"), true)).toMatchObject({ status: "FAULTED", tone: "flt" });
    expect(deviceAppearance("FAULTED", live("RUNNING"), true)).toMatchObject({ status: "RUNNING", tone: "run" });
  });

  it("shows a runtime that should be there but does not answer as not answering", () => {
    expect(shown("RUNNING", "DISCONNECTED")).toEqual({
      status: "RUNNING",
      tone: "disc",
      label: "No answer",
      live: true,
      pulse: false,
    });
    expect(shown("DEGRADED", "DISCONNECTED")).toMatchObject({ tone: "disc" });
    // A stopped device has nothing to answer, and a fault is not hidden by a lost connection.
    expect(shown("STOPPED", "DISCONNECTED")).toMatchObject({ tone: "off", label: "Stopped" });
    expect(shown("FAULTED", "DISCONNECTED")).toMatchObject({ tone: "flt", label: "Faulted" });
    // The quality of a stored snapshot says how old it is, not that anything is wrong.
    expect(shown("STOPPED", "STALE")).toMatchObject({ tone: "off" });
    expect(shown("RUNNING", "STALE")).toMatchObject({ tone: "run" });
  });

  it("never shows health nobody confirms: without a stream, and for a device the stream does not know", () => {
    for (const [streamLive, state] of [
      [false, live("RUNNING")],
      [false, undefined],
      [true, undefined],
    ] as const) {
      expect(deviceAppearance("RUNNING", state, streamLive)).toEqual({
        status: "RUNNING",
        tone: "deg",
        label: "Running · stale",
        live: false,
        pulse: false,
      });
    }
    expect(deviceAppearance("STOPPED", live("STARTING"), false)).toMatchObject({
      tone: "deg",
      label: "Starting · stale",
    });
    // What is not a claim of health stays as it was last known.
    expect(deviceAppearance("STOPPED", undefined, false)).toMatchObject({ tone: "off", label: "Stopped" });
    expect(deviceAppearance("DEGRADED", undefined, false)).toMatchObject({ tone: "deg", label: "Degraded" });
    expect(deviceAppearance("RUNNING", live("FAULTED"), false)).toMatchObject({
      tone: "flt",
      label: "Faulted",
      pulse: false,
    });
    for (const status of RUNTIME_STATES) {
      expect(deviceAppearance(status, undefined, false).tone, status).not.toBe("run");
      expect(deviceAppearance(status, live(status), false).tone, status).not.toBe("run");
    }
  });
});

describe("connection appearance", () => {
  const end = (status: RuntimeState, quality?: LiveDeviceState["quality"], streamLive = true): DeviceAppearance =>
    deviceAppearance(status, live(status, quality), streamLive);

  it("follows the 2D rule for confirmed states: red for a fault at either end, active when both run", () => {
    for (const source of RUNTIME_STATES) {
      for (const target of RUNTIME_STATES) {
        const appearance = connectionAppearance(end(source), end(target));
        expect(appearance.tone, `${source} → ${target}`).toBe(edgeTone(source, target));
        expect(appearance.animated, `${source} → ${target}`).toBe(source === "RUNNING" && target === "RUNNING");
      }
    }
  });

  it("stops the flow when an end faults, stops answering or is no longer confirmed", () => {
    expect(connectionAppearance(end("RUNNING"), end("RUNNING"))).toEqual({ tone: "active", animated: true });
    expect(connectionAppearance(end("RUNNING"), end("FAULTED"))).toEqual({ tone: "fault", animated: false });
    expect(connectionAppearance(end("RUNNING", "DISCONNECTED"), end("RUNNING"))).toEqual({
      tone: "idle",
      animated: false,
    });
    expect(connectionAppearance(end("RUNNING", "GOOD", false), end("RUNNING", "GOOD", false))).toEqual({
      tone: "idle",
      animated: false,
    });
    // A fault is shown on the connection however old the news of it is.
    expect(connectionAppearance(end("FAULTED", "GOOD", false), end("RUNNING", "GOOD", false))).toEqual({
      tone: "fault",
      animated: false,
    });
    expect(connectionAppearance(undefined, end("RUNNING"))).toEqual({ tone: "idle", animated: false });
  });
});

describe("scene animation", () => {
  it("runs the renderer continuously only while a fault pulses or a connection flows", () => {
    const still = [shown("RUNNING"), shown("STOPPED"), shown("DEGRADED")];
    expect(sceneIsAnimated(still, [{ tone: "idle", animated: false }])).toBe(false);
    expect(sceneIsAnimated([...still, shown("FAULTED")], [])).toBe(true);
    expect(sceneIsAnimated(still, [{ tone: "active", animated: true }])).toBe(true);
    expect(sceneIsAnimated([], [])).toBe(false);
  });
});
