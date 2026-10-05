/**
 * Wiring rules between PLC tags and the signals of simulated devices
 * (docs/device-simulation.md → PLC bridge). Pure functions; they throw `DomainError`.
 */
import { DomainError } from "@/lib/domain/errors";
import { DEVICE_SIGNALS, isSimulatedType, type SignalDefinition } from "@/lib/domain/simulation";
import type { AccessMode, TagDataType } from "@/lib/domain/tag";

export function assertSignalBinding(binding: {
  device: { name: string; simulatorType: string; runtimeType: string };
  signal: string;
  tag: { dataType: TagDataType; accessMode: AccessMode; region: "I" | "Q" | "M" };
}): SignalDefinition {
  const { device, tag } = binding;
  if (device.runtimeType !== "DEVICE_SIM" || !isSimulatedType(device.simulatorType)) {
    throw new DomainError("INCOMPATIBLE", `${device.name} is not a simulated device.`, {
      rule: "simulated-device",
      field: "sourceDeviceInstanceId",
    });
  }
  const signals = DEVICE_SIGNALS[device.simulatorType];
  const signal = signals.find((candidate) => candidate.key === binding.signal);
  if (!signal) {
    throw new DomainError("VALIDATION", `${device.name} has no signal "${binding.signal}".`, {
      rule: "device-signal",
      field: "sourceSignal",
      supported: signals.map((candidate) => candidate.key),
    });
  }
  if ((signal.kind === "BOOL") !== (tag.dataType === "BOOL")) {
    throw new DomainError(
      "INCOMPATIBLE",
      signal.kind === "BOOL"
        ? `Signal "${signal.key}" is on/off and needs a BOOL tag.`
        : `Signal "${signal.key}" is a number and needs a numeric tag.`,
      { rule: "signal-data-type", field: "dataType" },
    );
  }
  // PLC logic is the control authority: a device is wired to what the program computes,
  // never to a tag a gateway or the UI can write.
  if (tag.accessMode !== "READ_ONLY") {
    throw new DomainError(
      "INCOMPATIBLE",
      "A device signal is wired to PLC logic. Use a role other than COMMAND or SETPOINT and let the program drive it.",
      { rule: "signal-plc-driven", field: "role" },
    );
  }
  if (signal.direction === "IN" && tag.region === "I") {
    throw new DomainError("INCOMPATIBLE", "A device input is driven from a PLC output (%Q) or memory (%M) address.", {
      rule: "signal-address",
      field: "logicalAddress",
    });
  }
  // The OpenPLC runtime's Modbus server cannot write %I addresses (ADR-0009), so simulated
  // feedback can only be delivered to memory addresses.
  if (signal.direction === "OUT" && tag.region !== "M") {
    throw new DomainError(
      "INCOMPATIBLE",
      "Simulated feedback can only be delivered to a memory (%M) address; the runtime does not accept values on %I or %Q.",
      { rule: "signal-address", field: "logicalAddress" },
    );
  }
  return signal;
}
