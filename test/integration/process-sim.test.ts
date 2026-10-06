// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROCESS_SIM_CONTRACT_VERSION, PROCESS_SIM_MODELS, type ProcessSimConfig } from "@/lib/domain/process-sim";
import { createProcessSimClient, type ProcessSimClient } from "@/lib/runtimes/process-sim/client";

/**
 * Z-Factory against the running process simulation service (TASK-602): the built binary
 * is started here, driven through the server's client, and restarted. Runs when
 * PROCESS_SIM_BIN points at the binary (`go build -o … ./cmd/process-sim`); CI builds it.
 */
const binary = process.env.PROCESS_SIM_BIN;
const describeSim = binary ? describe : describe.skip;
const TOKEN = "integration-token-0123456789";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

function startService(port: number): ChildProcess {
  const child = spawn(binary ?? "", [], {
    env: {
      ...process.env,
      PROCESS_SIM_ADDR: `127.0.0.1:${port}`,
      PROCESS_SIM_TOKEN: TOKEN,
      PROCESS_SIM_MAX_INSTANCES: "4",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function waitForHealth(client: ProcessSimClient): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await client.health();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const stopService = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });

const config = (instanceId: string, overrides: Partial<ProcessSimConfig> = {}): ProcessSimConfig => ({
  contractVersion: PROCESS_SIM_CONTRACT_VERSION,
  instanceId,
  factoryId: "factory-1",
  moduleType: "PUMP_HOUSE",
  ...PROCESS_SIM_MODELS.PUMP_HOUSE!,
  configVersion: 1,
  tickMs: 100,
  clock: "manual",
  parameters: { ratedFlow: 80, ratedPressure: 5, rampTimeS: 10 },
  inputs: { DUTY_RUN_CMD: 1 },
  ...overrides,
});

describeSim("process simulation service", () => {
  let port: number;
  let child: ChildProcess;
  let client: ProcessSimClient;
  /** The outputs of a pump after 50 ticks at full setpoint, to compare other runs with. */
  let reference: Record<string, number> = {};

  beforeAll(async () => {
    port = await freePort();
    child = startService(port);
    client = createProcessSimClient({ url: `http://127.0.0.1:${port}`, token: TOKEN });
    await waitForHealth(client);
  }, 20_000);
  afterAll(async () => {
    await stopService(child);
  });

  it("reports its health and the models it has, and refuses the wrong token", async () => {
    const health = await client.health();
    expect(health).toMatchObject({
      status: "ok",
      contractVersion: PROCESS_SIM_CONTRACT_VERSION,
      modelTypes: ["PUMP_HOUSE", "TANK"],
    });
    const stranger = createProcessSimClient({ url: `http://127.0.0.1:${port}`, token: "wrong-token-0123456789" });
    await expect(stranger.list()).rejects.toMatchObject({ details: { rule: "process-sim-token" } });
    // The health check needs no token, so a probe can use it; everything else does.
    expect((await stranger.health()).status).toBe("ok");
  });

  it("runs independent instances deterministically: the same configuration and steps give the same values", async () => {
    await client.load(config("pump-a"));
    await client.load(config("pump-b"));
    const tank = await client.load(
      config("tank-1", {
        moduleType: "TANK",
        ...PROCESS_SIM_MODELS.TANK!,
        parameters: { volume: 40, inflowRate: 3600, valveTravelS: 1 },
        inputs: { INLET_VALVE_CMD: 1 },
        tickMs: 1000,
      }),
    );
    expect(tank).toMatchObject({ status: "LOADED", tick: 0, configVersion: 1 });

    await client.start("pump-a");
    await client.start("pump-b");
    await client.start("tank-1");
    const a = await client.step("pump-a", 50);
    const t = await client.step("tank-1", 10);
    const b = await client.step("pump-b", 50);

    expect(a.outputs).toMatchObject({ DUTY_RUNNING: 1, DUTY_SPEED: 50, FLOW: 40, DISCHARGE_PRESSURE: 1.25 });
    expect(b.outputs).toEqual(a.outputs);
    expect(b.state).toEqual(a.state);
    reference = a.outputs;
    expect(t.outputs).toMatchObject({ LEVEL: 25, INLET_VALVE_OPEN: 1 });
    // Stepping one instance moved no other.
    expect((await client.inspect("tank-1")).tick).toBe(10);
    expect((await client.inspect("pump-b")).tick).toBe(50);

    // Inputs change the course; a wrong input is refused.
    await client.setInputs("pump-a", { DUTY_SPEED_SETPOINT: 20 });
    const slowed = await client.step("pump-a", 50);
    expect(slowed.outputs.DUTY_SPEED).toBe(20);
    await expect(client.setInputs("pump-a", { LEVEL: 1 })).rejects.toMatchObject({ code: "VALIDATION" });
    const events = await client.events("pump-a");
    expect(events.map((event) => event.type)).toEqual(["PUMP_STARTED"]);
    const metrics = await client.metrics();
    expect(metrics).toMatchObject({ instances: 3, byStatus: { RUNNING: 3 } });
    expect(metrics.ticksTotal).toBe(160);
  });

  it("stops, continues, resets and unloads; refuses what the contract does not take", async () => {
    const stopped = await client.stop("pump-b");
    expect(stopped).toMatchObject({ status: "STOPPED", tick: 50 });
    await expect(client.step("pump-b", 1)).rejects.toMatchObject({ code: "CONFLICT" });
    await client.start("pump-b");
    expect((await client.step("pump-b", 10)).tick).toBe(60);

    const reset = await client.reset("pump-b");
    expect(reset).toMatchObject({ status: "LOADED", tick: 0, outputs: {}, inputs: { DUTY_RUN_CMD: 1 } });
    await client.start("pump-b");
    expect((await client.step("pump-b", 50)).outputs).toEqual(reference);

    await expect(client.load({ ...config("bad"), modelVersion: 9 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(client.load({ ...config("bad"), parameters: { boilerPower: 1 } })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(client.load({ ...config("bad"), contractVersion: 2 as never })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    // The instance limit of this service is four.
    await client.load(config("pump-c"));
    await expect(client.load(config("pump-d"))).rejects.toMatchObject({ code: "VALIDATION" });
    await client.unload("pump-c");
    await expect(client.inspect("pump-c")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await client.list()).map((snapshot) => snapshot.instanceId)).toEqual(["pump-a", "pump-b", "tank-1"]);
  });

  it("starts empty after a restart: Z-Factory owns the configuration and loads it again", async () => {
    await stopService(child);
    child = startService(port);
    await waitForHealth(client);

    expect(await client.list()).toEqual([]);
    await client.load(config("pump-a", { configVersion: 2 }));
    await client.start("pump-a");
    expect((await client.step("pump-a", 50)).outputs.DUTY_SPEED).toBe(50);
  }, 30_000);
});
