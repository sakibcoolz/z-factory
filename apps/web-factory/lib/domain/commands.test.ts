import { describe, expect, it } from "vitest";
import { afterAck, checkValue, commandEnvelope, sameValue } from "./commands";

const setpoint = {
  externalId: "t-speed",
  name: "Speed_SP",
  access: "WRITE",
  role: "SETPOINT",
  authority: "EXTERNAL_COMMAND",
  dataType: "INT16",
  min: 0,
  max: 50,
};
const start = {
  ...setpoint,
  externalId: "t-start",
  name: "Start_Cmd",
  role: "COMMAND",
  dataType: "BOOL",
  min: null,
  max: null,
};

describe("command checks (TASK-905)", () => {
  it("allows a value of the right kind in range on a command or setpoint tag only", () => {
    expect(checkValue(setpoint, 25)).toEqual({ ok: true, value: 25 });
    expect(checkValue(start, true)).toEqual({ ok: true, value: true });
    expect(checkValue(setpoint, 51)).toMatchObject({ ok: false, rule: "value-range" });
    expect(checkValue(setpoint, -0.1)).toMatchObject({ ok: false, rule: "value-range" });
    expect(checkValue(setpoint, Number.NaN)).toMatchObject({ ok: false, rule: "value-type" });
    expect(checkValue(setpoint, true)).toMatchObject({ ok: false, rule: "value-type" });
    expect(checkValue(start, 1)).toMatchObject({ ok: false, rule: "value-type" });
    expect(checkValue({ ...setpoint, min: null }, 1)).toMatchObject({ ok: false, rule: "value-range" });
    // Status, feedback and program outputs are the PLC program's.
    for (const tag of [
      { ...start, access: "READ" },
      { ...start, role: "STATUS" },
      { ...start, role: "FEEDBACK" },
      { ...start, authority: "PROGRAM_OUTPUT" },
    ]) {
      expect(checkValue(tag, true)).toMatchObject({ ok: false, rule: "not-writable" });
    }
  });

  it("builds exactly the envelope the agent reads, which refuses unknown fields", () => {
    const envelope = commandEnvelope({
      commandId: "0199-c",
      plcId: "plc-1",
      mappingId: "t-speed",
      value: 25,
      configVersion: 3,
      issuedAt: new Date("2026-10-07T10:00:00Z"),
      expiresAt: new Date("2026-10-07T10:01:00Z"),
      requestedBy: "user-1",
    });
    expect(Object.keys(envelope).sort()).toEqual(
      [
        "commandId",
        "configVersion",
        "expiresAt",
        "issuedAt",
        "mappingId",
        "plcId",
        "requestedBy",
        "schema",
        "value",
        "version",
      ].sort(),
    );
    expect(envelope).toMatchObject({ schema: "zfactory.command", version: 1, expiresAt: "2026-10-07T10:01:00.000Z" });
  });

  it("moves a command forward on acknowledgements, never back", () => {
    expect(afterAck("PUBLISHED", { status: "ACCEPTED" })).toEqual({ status: "ACCEPTED", late: false });
    expect(afterAck("ACCEPTED", { status: "APPLIED" })).toEqual({ status: "APPLIED", late: false });
    expect(afterAck("PUBLISHED", { status: "REJECTED" })).toEqual({ status: "REJECTED", late: false });
    // An answer after the timeout is taken, marked late.
    expect(afterAck("TIMED_OUT", { status: "APPLIED" })).toEqual({ status: "APPLIED", late: true });
    // Never back, and a redelivery changes nothing.
    expect(afterAck("APPLIED", { status: "ACCEPTED" })).toBeNull();
    expect(afterAck("APPLIED", { status: "FAILED" })).toBeNull();
    expect(afterAck("TIMED_OUT", { status: "ACCEPTED" })).toBeNull();
    expect(afterAck("ACCEPTED", { status: "APPLIED", duplicate: true })).toBeNull();
  });

  it("matches the commanded value in telemetry", () => {
    expect(sameValue(true, true)).toBe(true);
    expect(sameValue(true, false)).toBe(false);
    expect(sameValue(24.7, 24.700000000000003)).toBe(true);
    expect(sameValue(24.7, 24.8)).toBe(false);
    expect(sameValue(1, null)).toBe(false);
  });
});
