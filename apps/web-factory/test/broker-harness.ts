import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { withDb } from "./harness";

/**
 * A real Mosquitto with Dynamic Security for the Docker tests (TASK-902, TASK-903). Needs
 * WEB_FACTORY_TEST_DOCKER=1 (or TEST_DOCKER=1); AGENT_BIN is the built zfactory-agent.
 */
export const withDocker = process.env.WEB_FACTORY_TEST_DOCKER === "1" || process.env.TEST_DOCKER === "1";
export const withBroker = withDb && withDocker;
export const agentBinary = process.env.AGENT_BIN;

const IMAGE = "eclipse-mosquitto:2";
const CONFIG = resolve(__dirname, "../broker/mosquitto.conf");

export const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

export async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Starts a broker on a free loopback port; the admin password goes to `<dir>/admin-password`. */
export async function startBroker(
  dir: string,
  label: string,
): Promise<{ container: string; url: string; passwordFile: string }> {
  const adminPassword = randomBytes(18).toString("base64url");
  const passwordFile = join(dir, "admin-password");
  writeFileSync(passwordFile, `${adminPassword}\n`, { mode: 0o600 });
  const port = await freePort();
  const container = docker(
    "run",
    "-d",
    "--label",
    `web-factory-test=${label}`,
    "-e",
    `MOSQUITTO_DYNSEC_PASSWORD=${adminPassword}`,
    "-p",
    `127.0.0.1:${port}:1883`,
    "-v",
    `${CONFIG}:/mosquitto/config/mosquitto.conf:ro`,
    IMAGE,
  );
  return { container, url: `mqtt://127.0.0.1:${port}`, passwordFile };
}
