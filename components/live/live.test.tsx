import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEventEnvelope } from "@/lib/domain/events";
import type { LiveMessage, LiveTagReading } from "@/lib/domain/live";
import type { OperationState } from "@/lib/plc/operation-state";
import { LiveEventLog } from "./live-event-log";
import { LiveRefresh } from "./live-refresh";
import { LiveTagTable, type LiveTagTableRow } from "./live-tag-table";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

/** The browser's EventSource, as far as the stream hook uses it. */
class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  static get current(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error("no stream was opened");
    return source;
  }

  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(kind: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }
  removeEventListener() {}
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  open() {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  drop(permanently = false) {
    this.readyState = permanently ? FakeEventSource.CLOSED : 0;
    act(() => this.onerror?.());
  }
  /** Delivers a message the way the server encodes it. */
  send(message: LiveMessage) {
    const data = message.kind === "event" ? message.event : message;
    const event = { data: JSON.stringify(data), lastEventId: message.kind === "event" ? message.event.id : "" };
    act(() => this.listeners.get(message.kind)?.forEach((listener) => listener(event as MessageEvent<string>)));
  }
}

const T0 = Date.parse("2026-10-05T05:00:00.000Z");
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  refresh.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

const reading = (name: string, overrides: Partial<LiveTagReading> = {}): LiveTagReading => ({
  plcId: "plc-1",
  name,
  value: 0,
  quality: "GOOD",
  readAt: iso(0),
  ...overrides,
});

function tagRows(write?: (state: OperationState, formData: FormData) => Promise<OperationState>): LiveTagTableRow[] {
  const row = (name: string, extra: Partial<LiveTagTableRow>): LiveTagTableRow => ({
    plcId: "plc-1",
    plcName: "PLC-01",
    name,
    role: "STATUS",
    dataType: "BOOL",
    unit: null,
    logicalAddress: "%QX0.0",
    deviceName: null,
    reading: reading(name, { value: false }),
    write: null,
    ...extra,
  });
  return [
    row("Start_Cmd", { role: "COMMAND", write: write ?? null }),
    row("Speed_Sp", {
      role: "SETPOINT",
      dataType: "INT16",
      unit: "Hz",
      reading: reading("Speed_Sp", { value: 25 }),
      write: write ?? null,
    }),
    row("VFD_Running", { deviceName: "VFD-01", reading: reading("VFD_Running", { value: false }) }),
  ];
}

const cells = (tag: string) => {
  const row = screen.getByText(tag).closest("tr");
  if (!row) throw new Error(`no row for ${tag}`);
  return within(row);
};
const tagsMessage = (readings: LiveTagReading[], seconds: number, confirmed = true): LiveMessage => ({
  kind: "tags",
  factoryId: "factory-1",
  plcId: "plc-1",
  at: iso(seconds),
  confirmed,
  readings,
});

describe("LiveTagTable", () => {
  const renderTable = (write?: Parameters<typeof tagRows>[0]) =>
    render(<LiveTagTable rows={tagRows(write)} streamUrl="/factories/f/stream" staleAfterMs={5000} showPlc={false} />);

  it("shows value, quality and age, and follows the stream without a reload", () => {
    renderTable();
    expect(FakeEventSource.current.url).toBe("/factories/f/stream");
    expect(screen.getByText("stream · connecting")).toBeInTheDocument();
    expect(cells("Speed_Sp").getByText("25 Hz")).toBeInTheDocument();
    expect(cells("VFD_Running").getByText("OFF")).toBeInTheDocument();
    expect(cells("VFD_Running").getByText("VFD-01")).toBeInTheDocument();

    FakeEventSource.current.open();
    expect(screen.getByText("stream · live")).toBeInTheDocument();
    FakeEventSource.current.send(tagsMessage([reading("VFD_Running", { value: true, readAt: iso(1) })], 1));
    expect(cells("VFD_Running").getByText("ON")).toBeInTheDocument();
    expect(screen.getByText("GOOD 3")).toBeInTheDocument();
  });

  it("turns a value stale when nothing confirms it, and good again when the PLC answers", () => {
    renderTable();
    FakeEventSource.current.open();
    act(() => void vi.advanceTimersByTime(7000));
    expect(screen.getByText("STALE 3")).toBeInTheDocument();
    expect(cells("Speed_Sp").getByText("STALE")).toBeInTheDocument();
    expect(cells("Speed_Sp").getByText("7 s")).toBeInTheDocument();

    // The PLC answered with nothing changed: every good value is fresh again.
    FakeEventSource.current.send(tagsMessage([], 7));
    expect(screen.getByText("GOOD 3")).toBeInTheDocument();
    expect(cells("Speed_Sp").getByText("now")).toBeInTheDocument();
  });

  it("does not present values as current while the stream is interrupted", () => {
    renderTable();
    FakeEventSource.current.open();
    FakeEventSource.current.drop();
    expect(screen.getByText("stream · reconnecting")).toBeInTheDocument();
    expect(screen.getByText("STALE 3")).toBeInTheDocument();
    FakeEventSource.current.open();
    expect(screen.getByText("GOOD 3")).toBeInTheDocument();
    FakeEventSource.current.drop(true);
    expect(screen.getByText("stream · offline")).toBeInTheDocument();
  });

  it("shows a PLC that went away as disconnected, keeping what the server last knew", () => {
    renderTable();
    FakeEventSource.current.open();
    FakeEventSource.current.send(
      tagsMessage(
        ["Start_Cmd", "Speed_Sp", "VFD_Running"].map((name) =>
          reading(name, { value: null, quality: "DISCONNECTED", readAt: null }),
        ),
        3,
        false,
      ),
    );
    expect(screen.getByText("DISC 3")).toBeInTheDocument();
    expect(cells("Speed_Sp").getByText("—")).toBeInTheDocument();
    expect(cells("Speed_Sp").getByText("never")).toBeInTheDocument();
  });

  it("takes the whole state from a snapshot after a reconnect", () => {
    renderTable();
    FakeEventSource.current.open();
    FakeEventSource.current.send({
      kind: "snapshot",
      snapshot: {
        factoryId: "factory-1",
        at: iso(30),
        tags: [reading("Speed_Sp", { value: 42, readAt: iso(30) })],
        devices: [],
        activeAlarms: 0,
      },
    });
    expect(cells("Speed_Sp").getByText("42 Hz")).toBeInTheDocument();
  });

  it("writes only command and setpoint tags, and reports what the PLC answered", async () => {
    vi.useRealTimers();
    const write = vi.fn(async (_state: OperationState, formData: FormData) => {
      void formData;
      return { notice: "Accepted by the PLC." };
    });
    renderTable(write);
    expect(cells("VFD_Running").getByText("read-only")).toBeInTheDocument();
    expect(cells("VFD_Running").queryByRole("button")).not.toBeInTheDocument();

    fireEvent.click(cells("Start_Cmd").getByRole("button", { name: "Set ON" }));
    expect(await cells("Start_Cmd").findByText("Accepted by the PLC.")).toBeInTheDocument();
    fireEvent.change(cells("Speed_Sp").getByLabelText("New value for Speed_Sp in Hz"), { target: { value: "37.5" } });
    fireEvent.click(cells("Speed_Sp").getByRole("button", { name: "Write" }));
    expect(await cells("Speed_Sp").findByText("Accepted by the PLC.")).toBeInTheDocument();
    expect(write.mock.calls.map(([, formData]) => formData.get("value"))).toEqual(["true", "37.5"]);
  });

  it("releases its connection while the tab is hidden and resumes after the last event it saw", () => {
    renderTable();
    const first = FakeEventSource.current;
    first.open();
    first.send({ kind: "event", event: envelope("0199b000-0000-7000-8000-00000000000a", "DEVICE_RUNNING") });

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(screen.getByText("stream · paused")).toBeInTheDocument();

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.current.url).toBe("/factories/f/stream?lastEventId=0199b000-0000-7000-8000-00000000000a");
  });
});

function envelope(id: string, type: string, extra: Partial<RuntimeEventEnvelope> = {}): RuntimeEventEnvelope {
  return {
    version: 1,
    id,
    type,
    factoryId: "factory-1",
    deviceId: "dev-1",
    severity: "INFO",
    occurredAt: iso(Number.parseInt(id.slice(-2), 16)),
    payload: {},
    ...extra,
  };
}
const id = (n: number) => `0199b000-0000-7000-8000-0000000000${n.toString(16).padStart(2, "0")}`;

describe("LiveEventLog", () => {
  const history = [envelope(id(2), "DEVICE_RUNNING"), envelope(id(1), "DEVICE_STARTING")];
  const renderLog = (filter = {}) =>
    render(<LiveEventLog events={history} streamUrl="/s" filter={filter} deviceNames={{ "dev-1": "PLC-01" }} />);
  const types = () => screen.getAllByText(/^[A-Z_]+$/, { selector: ".syn-type" }).map((element) => element.textContent);

  it("shows the recorded history and puts new events on top as they arrive", () => {
    renderLog();
    expect(types()).toEqual(["DEVICE_RUNNING", "DEVICE_STARTING"]);
    FakeEventSource.current.open();
    FakeEventSource.current.send({
      kind: "event",
      event: envelope(id(3), "FAULT_INJECTED", { severity: "WARNING", payload: { name: "Stuck", code: "STUCK" } }),
    });
    expect(types()).toEqual(["FAULT_INJECTED", "DEVICE_RUNNING", "DEVICE_STARTING"]);
    expect(screen.getByText(/name Stuck · code STUCK/)).toBeInTheDocument();
    expect(screen.getByText("Event stream · 3")).toBeInTheDocument();
    expect(screen.getAllByText(/PLC-01/)).toHaveLength(3);
  });

  it("shows an event once, however often it is delivered", () => {
    renderLog();
    FakeEventSource.current.open();
    // A replay after a reconnect can contain what the page already rendered.
    FakeEventSource.current.send({ kind: "event", event: history[0] as RuntimeEventEnvelope });
    FakeEventSource.current.send({ kind: "event", event: envelope(id(3), "DEVICE_STOPPED") });
    FakeEventSource.current.send({ kind: "event", event: envelope(id(3), "DEVICE_STOPPED") });
    expect(types()).toEqual(["DEVICE_STOPPED", "DEVICE_RUNNING", "DEVICE_STARTING"]);
  });

  it("applies the page's filter to live events too", () => {
    renderLog({ severity: "CRITICAL" });
    expect(screen.getByText(/No events match/)).toBeInTheDocument();
    FakeEventSource.current.open();
    FakeEventSource.current.send({ kind: "event", event: envelope(id(3), "DEVICE_STOPPED") });
    FakeEventSource.current.send({ kind: "event", event: envelope(id(4), "DEVICE_FAULTED", { severity: "CRITICAL" }) });
    expect(types()).toEqual(["DEVICE_FAULTED"]);
  });

  it("refreshes the alarm list for alarm events, and everything after a reset", () => {
    renderLog();
    FakeEventSource.current.open();
    FakeEventSource.current.send({ kind: "event", event: envelope(id(3), "DEVICE_STOPPED") });
    act(() => void vi.advanceTimersByTime(1000));
    expect(refresh).not.toHaveBeenCalled();

    FakeEventSource.current.send({ kind: "event", event: envelope(id(4), "ALARM_RAISED", { severity: "CRITICAL" }) });
    FakeEventSource.current.send({ kind: "event", event: envelope(id(5), "ALARM_CLEARED") });
    act(() => void vi.advanceTimersByTime(1000));
    expect(refresh).toHaveBeenCalledOnce();

    FakeEventSource.current.send({ kind: "reset", reason: "TOO_MANY_EVENTS" });
    expect(refresh).toHaveBeenCalledTimes(2);
    // What was received live is dropped: the history is read again.
    expect(types()).toEqual(["DEVICE_RUNNING", "DEVICE_STARTING"]);
  });
});

describe("LiveRefresh", () => {
  it("re-reads the page once for a burst of events, and not for tag values", () => {
    render(<LiveRefresh streamUrl="/s" />);
    FakeEventSource.current.open();
    FakeEventSource.current.send(tagsMessage([], 1));
    FakeEventSource.current.send({ kind: "heartbeat", at: iso(1) });
    act(() => void vi.advanceTimersByTime(1000));
    expect(refresh).not.toHaveBeenCalled();

    for (const n of [1, 2, 3])
      FakeEventSource.current.send({ kind: "event", event: envelope(id(n), "VFD_STATE_CHANGED") });
    act(() => void vi.advanceTimersByTime(399));
    expect(refresh).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
