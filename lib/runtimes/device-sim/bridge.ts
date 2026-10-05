import "server-only";
import type { SignalDirection, SignalKind } from "@/lib/domain/simulation";
import type { ModbusArea } from "@/lib/domain/tag";
import { decodeValue, type Encoding, encodeValue, engineeringRange } from "@/lib/protocols/modbus/codec";
import type { Signals, SignalValue } from "./engine";

/**
 * Carries values between PLCs and the device simulation, the way field wiring would:
 * PLC outputs become device inputs, device outputs become PLC feedback. It only uses tags
 * bound to a device signal; it is not a gateway and never writes a command or setpoint.
 */

/** One device signal bound to one PLC tag. */
export type SignalBinding = {
  deviceId: string;
  signal: string;
  direction: SignalDirection;
  kind: SignalKind;
  plcId: string;
  tagName: string;
  area: ModbusArea;
  /** Zero-based address within the area. */
  address: number;
  wordCount: number;
  encoding: Encoding;
};

/** Raw Modbus access to one PLC. */
export interface PlcIo {
  read(area: ModbusArea, address: number, count: number): Promise<Array<number | boolean>>;
  writeCoil(address: number, value: boolean): Promise<void>;
  writeRegisters(address: number, words: readonly number[]): Promise<void>;
}

export type LinkChange = { plcId: string; up: boolean };

export type BridgeOptions = {
  /** Every feedback value is rewritten after this many cycles even when unchanged. */
  refreshEveryTicks?: number;
  /** A PLC that could not be reached is tried again after this time. */
  retryMs?: number;
  now?: () => number;
};

type Span = { area: ModbusArea; address: number; count: number };
type Run = { address: number; bindings: SignalBinding[] };
type Link = {
  plcId: string;
  io: PlcIo;
  inputs: SignalBinding[];
  outputs: SignalBinding[];
  spans: Span[];
  runs: Run[];
  /** Undefined until the first exchange. */
  up: boolean | undefined;
  retryAt: number;
  /** Last value written per tag, to write only what changed. */
  written: Map<string, string>;
  ticksSinceRefresh: number;
};

const isBitArea = (area: ModbusArea) => area === "COIL" || area === "DISCRETE_INPUT";
const MAX_REGISTERS_PER_WRITE = 123;

/** Groups input tags into few read requests: neighbours share one request. */
function planReads(bindings: readonly SignalBinding[]): Span[] {
  const spans: Span[] = [];
  for (const area of ["COIL", "DISCRETE_INPUT", "HOLDING_REGISTER", "INPUT_REGISTER"] as const) {
    const limit = isBitArea(area) ? 2000 : 125;
    const gap = isBitArea(area) ? 64 : 16;
    let current: Span | undefined;
    for (const binding of bindings.filter((b) => b.area === area).sort((a, b) => a.address - b.address)) {
      const end = binding.address + binding.wordCount;
      if (current && binding.address <= current.address + current.count + gap && end - current.address <= limit) {
        current.count = Math.max(current.count, end - current.address);
      } else {
        current = { area, address: binding.address, count: binding.wordCount };
        spans.push(current);
      }
    }
  }
  return spans;
}

/** Feedback registers that follow each other directly are written in one request. */
function planRegisterWrites(bindings: readonly SignalBinding[]): Run[] {
  const runs: Run[] = [];
  let current: Run | undefined;
  let end = 0;
  for (const binding of bindings.filter((b) => b.area === "HOLDING_REGISTER").sort((a, b) => a.address - b.address)) {
    if (current && binding.address === end && end + binding.wordCount - current.address <= MAX_REGISTERS_PER_WRITE) {
      current.bindings.push(binding);
    } else {
      current = { address: binding.address, bindings: [binding] };
      runs.push(current);
    }
    end = binding.address + binding.wordCount;
  }
  return runs;
}

/** A PLC that cannot be read drives nothing: its outputs count as de-energized. */
const deEnergized = (binding: SignalBinding): SignalValue => (binding.kind === "BOOL" ? false : 0);

/** Encodes a simulated value; a value beyond the tag's range saturates like an analog input card. */
function encodeSaturated(value: SignalValue | undefined, binding: SignalBinding): number[] | boolean {
  if (binding.encoding.dataType === "BOOL") return value === true || (typeof value === "number" && value !== 0);
  const number = typeof value === "number" && Number.isFinite(value) ? value : value === true ? 1 : 0;
  const [min, max] = engineeringRange(binding.encoding);
  return encodeValue(Math.min(Math.max(number, min), max), binding.encoding);
}

export class PlcBridge {
  private readonly links: Link[];
  private readonly refreshEveryTicks: number;
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(bindings: readonly SignalBinding[], plcs: ReadonlyMap<string, PlcIo>, options: BridgeOptions = {}) {
    this.refreshEveryTicks = options.refreshEveryTicks ?? 50;
    this.retryMs = options.retryMs ?? 2000;
    this.now = options.now ?? (() => performance.now());
    this.links = [...plcs].map(([plcId, io]) => {
      const own = bindings.filter((binding) => binding.plcId === plcId);
      const inputs = own.filter((binding) => binding.direction === "IN");
      const outputs = own.filter((binding) => binding.direction === "OUT");
      return {
        plcId,
        io,
        inputs,
        outputs,
        spans: planReads(inputs),
        runs: planRegisterWrites(outputs),
        up: undefined,
        retryAt: 0,
        written: new Map(),
        ticksSinceRefresh: 0,
      };
    });
  }

  private setLink(link: Link, up: boolean, changes: LinkChange[]): void {
    if (!up) {
      link.retryAt = this.now() + this.retryMs;
      // Whatever the PLC held is unknown once it was away: write everything again.
      link.written.clear();
    }
    if (link.up !== up) changes.push({ plcId: link.plcId, up });
    link.up = up;
  }

  private waiting(link: Link): boolean {
    return link.up === false && this.now() < link.retryAt;
  }

  private async readLink(link: Link, target: Map<string, Signals>, changes: LinkChange[]): Promise<void> {
    const assign = (binding: SignalBinding, value: SignalValue) => {
      const signals = target.get(binding.deviceId) ?? {};
      signals[binding.signal] = value;
      target.set(binding.deviceId, signals);
    };
    const drop = () => link.inputs.forEach((binding) => assign(binding, deEnergized(binding)));

    if (this.waiting(link)) return drop();
    try {
      const data = await Promise.all(link.spans.map((span) => link.io.read(span.area, span.address, span.count)));
      for (const binding of link.inputs) {
        const index = link.spans.findIndex(
          (span) =>
            span.area === binding.area &&
            binding.address >= span.address &&
            binding.address + binding.wordCount <= span.address + span.count,
        );
        const span = link.spans[index];
        const values = data[index];
        if (!span || !values) continue;
        const start = binding.address - span.address;
        assign(binding, decodeValue(values.slice(start, start + binding.wordCount), binding.encoding));
      }
      this.setLink(link, true, changes);
    } catch {
      this.setLink(link, false, changes);
      drop();
    }
  }

  /**
   * Reads what each PLC drives. Returns, per device, every bound input signal; the
   * signals of a PLC that cannot be reached are de-energized (false / 0).
   */
  async readInputs(): Promise<{ inputs: Map<string, Signals>; changes: LinkChange[] }> {
    const inputs = new Map<string, Signals>();
    const changes: LinkChange[] = [];
    await Promise.all(this.links.map((link) => this.readLink(link, inputs, changes)));
    return { inputs, changes };
  }

  private async writeLink(link: Link, outputs: (deviceId: string) => Signals, changes: LinkChange[]): Promise<void> {
    if (link.outputs.length === 0 || this.waiting(link)) return;
    link.ticksSinceRefresh += 1;
    if (link.ticksSinceRefresh >= this.refreshEveryTicks) {
      link.ticksSinceRefresh = 0;
      link.written.clear();
    }

    const encoded = new Map<SignalBinding, number[] | boolean>();
    const changed = (binding: SignalBinding) => {
      const value = encodeSaturated(outputs(binding.deviceId)[binding.signal], binding);
      encoded.set(binding, value);
      return link.written.get(binding.tagName) !== JSON.stringify(value);
    };
    const remember = (binding: SignalBinding) =>
      link.written.set(binding.tagName, JSON.stringify(encoded.get(binding)));

    try {
      for (const binding of link.outputs.filter((b) => b.area === "COIL")) {
        if (!changed(binding)) continue;
        await link.io.writeCoil(binding.address, encoded.get(binding) === true);
        remember(binding);
      }
      for (const run of link.runs) {
        // Evaluate every tag of the run: one changed value rewrites the whole run.
        if (run.bindings.map(changed).every((isChanged) => !isChanged)) continue;
        await link.io.writeRegisters(
          run.address,
          run.bindings.flatMap((binding) => encoded.get(binding) as number[]),
        );
        run.bindings.forEach(remember);
      }
      this.setLink(link, true, changes);
    } catch {
      this.setLink(link, false, changes);
    }
  }

  /** Writes the simulated feedback into the PLCs: only what changed, plus a periodic refresh. */
  async writeOutputs(outputs: (deviceId: string) => Signals): Promise<LinkChange[]> {
    const changes: LinkChange[] = [];
    await Promise.all(this.links.map((link) => this.writeLink(link, outputs, changes)));
    return changes;
  }
}
