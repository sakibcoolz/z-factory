import { describe, expect, it } from "vitest";
import { DEVICE_SIGNALS, deviceSignalDirection } from "@/lib/domain/simulation";
import { type AuthorityTag, isExternallyWritable, tagAuthority } from "@/lib/domain/tag-authority";

const tag = (overrides: Partial<AuthorityTag>): AuthorityTag => ({
  role: "STATUS",
  accessMode: "READ_ONLY",
  logicalAddress: "%MW0",
  plcIoPointId: null,
  sourceSignal: null,
  ...overrides,
});

describe("who drives a tag (ADR-0015)", () => {
  it("gives local I/O points to the program and the field, whatever their role", () => {
    expect(tagAuthority(tag({ plcIoPointId: "p1", logicalAddress: "%QX0.0" }))).toBe("PROGRAM_OUTPUT");
    expect(tagAuthority(tag({ plcIoPointId: "p1", logicalAddress: "%QW3", role: "FEEDBACK" }))).toBe("PROGRAM_OUTPUT");
    expect(tagAuthority(tag({ plcIoPointId: "p2", logicalAddress: "%MX0.0", sourceSignal: "opened" }))).toBe(
      "PROGRAM_INPUT",
    );
    expect(tagAuthority(tag({ plcIoPointId: "p3", logicalAddress: "%MW2", role: "PROCESS_VALUE" }))).toBe(
      "PROGRAM_INPUT",
    );
    expect(tagAuthority(tag({ logicalAddress: "%IX0.0" }))).toBe("PROGRAM_INPUT");
  });

  it("gives writable command and setpoint memory to external writers, and the rest of %Q to the program", () => {
    expect(tagAuthority(tag({ role: "COMMAND", accessMode: "READ_WRITE", logicalAddress: "%QX100.0" }))).toBe(
      "EXTERNAL_COMMAND",
    );
    expect(tagAuthority(tag({ role: "SETPOINT", accessMode: "READ_WRITE", logicalAddress: "%MW100" }))).toBe(
      "EXTERNAL_COMMAND",
    );
    // A command role that is not writable is not a command anyone outside can give.
    expect(tagAuthority(tag({ role: "COMMAND", accessMode: "READ_ONLY", logicalAddress: "%QX100.0" }))).toBe(
      "PROGRAM_OUTPUT",
    );
    expect(tagAuthority(tag({ role: "ALARM", logicalAddress: "%QX100.2" }))).toBe("PROGRAM_OUTPUT");
  });

  it("gives memory a bridge fills to the simulation, and the rest to the program", () => {
    expect(tagAuthority(tag({ logicalAddress: "%MD0", sourceSignal: "value", role: "PROCESS_VALUE" }))).toBe(
      "SIMULATION_FEEDBACK",
    );
    expect(tagAuthority(tag({ logicalAddress: "%MX10.0", moduleSignalDirection: "INPUT" }))).toBe(
      "SIMULATION_FEEDBACK",
    );
    expect(tagAuthority(tag({ logicalAddress: "%MX10.1", moduleSignalDirection: "ALARM" }))).toBe(
      "SIMULATION_FEEDBACK",
    );
    expect(tagAuthority(tag({ logicalAddress: "%MX10.2", sourceSignal: "running" }))).toBe("SIMULATION_FEEDBACK");
    expect(tagAuthority(tag({ logicalAddress: "%MW50" }))).toBe("PROGRAM_INTERNAL");
    expect(tagAuthority(tag({ logicalAddress: null }))).toBe("PROGRAM_INTERNAL");
  });

  it("keeps a command the program gives simulated equipment apart from feedback (TASK-803)", () => {
    // A device command or a module command the program drives is its output, wherever it sits.
    expect(tagAuthority(tag({ logicalAddress: "%MX11.0", sourceSignal: "run" }))).toBe("PROGRAM_OUTPUT");
    expect(tagAuthority(tag({ logicalAddress: "%MW12", sourceSignal: "frequencySetpoint", role: "STATUS" }))).toBe(
      "PROGRAM_OUTPUT",
    );
    expect(tagAuthority(tag({ logicalAddress: "%QX0.3", sourceSignal: "open" }))).toBe("PROGRAM_OUTPUT");
    expect(tagAuthority(tag({ logicalAddress: "%MX11.1", moduleSignalDirection: "OUTPUT" }))).toBe("PROGRAM_OUTPUT");
    // Its actual value comes back as feedback.
    expect(tagAuthority(tag({ logicalAddress: "%MW13", sourceSignal: "actualFrequency" }))).toBe("SIMULATION_FEEDBACK");
    expect(isExternallyWritable(tag({ logicalAddress: "%MX11.0", sourceSignal: "run" }))).toBe(false);
  });

  it("reads a device signal's direction from its key: a key flows the same way in every type", () => {
    for (const signals of Object.values(DEVICE_SIGNALS)) {
      for (const signal of signals) expect(deviceSignalDirection(signal.key), signal.key).toBe(signal.direction);
    }
    expect(deviceSignalDirection("nothing")).toBeUndefined();
  });

  it("lets normal control writes reach external command memory only", () => {
    expect(isExternallyWritable(tag({ role: "COMMAND", accessMode: "READ_WRITE", logicalAddress: "%QX100.0" }))).toBe(
      true,
    );
    expect(isExternallyWritable(tag({ plcIoPointId: "p1", logicalAddress: "%QX0.0" }))).toBe(false);
    expect(isExternallyWritable(tag({ role: "ALARM", logicalAddress: "%QX100.2" }))).toBe(false);
    expect(isExternallyWritable(tag({ logicalAddress: "%MD0", sourceSignal: "value" }))).toBe(false);
  });
});
