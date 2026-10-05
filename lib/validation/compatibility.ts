/**
 * Catalog compatibility between a PLC's channels or ports and a peripheral's terminals or
 * ports (docs/device-catalog.md → PLC compatibility). Pure functions.
 */
import type { IoDirection, IoPointType, IoSignalClass } from "@/lib/domain/device";
import { channelAccepts, requiredIoPointType } from "@/lib/validation/connection";

export type PlcChannel = { ioType: IoPointType; signalType: string; acceptedSignalTypes?: readonly string[] };

export type DeviceTerminal = {
  terminalLabel: string | null;
  direction: IoDirection;
  ioType: IoSignalClass;
  signalType: string;
};

export type TerminalMatch = {
  terminalLabel: string | null;
  /** PLC point class the terminal lands on. */
  required: IoPointType;
  signalType: string;
  /** Channels that could take this terminal, before sharing them with other terminals. */
  candidates: number;
  /** Whether a channel was left for this terminal once all terminals were placed. */
  satisfied: boolean;
};

const accepts = (channel: PlcChannel, terminal: DeviceTerminal) =>
  channel.ioType === requiredIoPointType(terminal.direction, terminal.ioType) &&
  channelAccepts(channel, terminal.signalType);

/**
 * Places every terminal on its own channel. Terminals with the fewest candidates are
 * placed first, so a scarce channel is not spent on a terminal that had other options.
 */
export function matchTerminals(
  terminals: readonly DeviceTerminal[],
  channels: readonly PlcChannel[],
): { compatible: boolean; terminals: TerminalMatch[] } {
  const options = terminals.map((terminal) =>
    channels.flatMap((channel, index) => (accepts(channel, terminal) ? [index] : [])),
  );
  const used = new Set<number>();
  const satisfied = new Array<boolean>(terminals.length).fill(false);
  const order = terminals
    .map((_, index) => index)
    .sort((a, b) => (options[a]?.length ?? 0) - (options[b]?.length ?? 0));
  for (const index of order) {
    const free = (options[index] ?? []).find((channel) => !used.has(channel));
    if (free === undefined) continue;
    used.add(free);
    satisfied[index] = true;
  }
  const matches = terminals.map((terminal, index) => ({
    terminalLabel: terminal.terminalLabel,
    required: requiredIoPointType(terminal.direction, terminal.ioType),
    signalType: terminal.signalType,
    candidates: options[index]?.length ?? 0,
    satisfied: satisfied[index] === true,
  }));
  return { compatible: matches.every((match) => match.satisfied), terminals: matches };
}

/**
 * For a modular PLC the number of channels is not fixed: modules can be added. A terminal
 * is satisfied when at least one installable module has a channel for it.
 */
export function matchTerminalsToModules(
  terminals: readonly DeviceTerminal[],
  modules: ReadonlyArray<{ modelName: string; channels: readonly PlcChannel[] }>,
): { compatible: boolean; terminals: Array<TerminalMatch & { modules: string[] }> } {
  const matches = terminals.map((terminal) => {
    const fitting = modules.filter((candidate) => candidate.channels.some((channel) => accepts(channel, terminal)));
    return {
      terminalLabel: terminal.terminalLabel,
      required: requiredIoPointType(terminal.direction, terminal.ioType),
      signalType: terminal.signalType,
      candidates: fitting.length,
      satisfied: fitting.length > 0,
      modules: fitting.map((candidate) => candidate.modelName),
    };
  });
  return { compatible: matches.every((match) => match.satisfied), terminals: matches };
}

/** Protocols both sides have a port for. */
export function sharedProtocols(
  plcPorts: ReadonlyArray<{ protocols: readonly string[] }>,
  devicePorts: ReadonlyArray<{ protocols: readonly string[] }>,
): string[] {
  const plc = new Set(plcPorts.flatMap((port) => port.protocols));
  return [...new Set(devicePorts.flatMap((port) => port.protocols))].filter((protocol) => plc.has(protocol)).sort();
}
