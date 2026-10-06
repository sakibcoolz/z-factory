import { describe, expect, it } from "vitest";
import { EnvironmentError, parseServerEnv } from "./env";

const url = "postgresql://user:secret@localhost:5432/zfactory";

describe("server environment contract", () => {
  it("accepts a PostgreSQL connection string and applies the runtime defaults", () => {
    expect(parseServerEnv({ DATABASE_URL: url })).toEqual({
      DATABASE_URL: url,
      DOCKER_HOST: "unix:///var/run/docker.sock",
      RUNTIME_PORT_RANGE: "15000-15999",
      RUNTIME_BIND_ADDRESSES: "127.0.0.1",
      SIMULATION_TICK_MS: 100,
      SIMULATION_SNAPSHOT_MS: 10_000,
      ASSET_STORAGE_DIR: "./data/assets",
      PROCESS_SIM_TICK_MS: 100,
      PROCESS_BRIDGE_CYCLE_MS: 200,
      TAG_POLL_MS: 500,
      TELEMETRY_MIN_INTERVAL_MS: 1000,
      TELEMETRY_MAX_INTERVAL_MS: 60_000,
      TELEMETRY_DEADBAND_PERCENT: 1,
      TELEMETRY_RETENTION_HOURS: 24,
      EVENT_RETENTION_DAYS: 30,
    });
  });

  it("takes the live-value and telemetry settings as numbers within limits", () => {
    expect(
      parseServerEnv({
        DATABASE_URL: url,
        TAG_POLL_MS: "250",
        TELEMETRY_DEADBAND_PERCENT: "0.5",
        TELEMETRY_RETENTION_HOURS: "72",
        EVENT_RETENTION_DAYS: "7",
      }),
    ).toMatchObject({
      TAG_POLL_MS: 250,
      TELEMETRY_DEADBAND_PERCENT: 0.5,
      TELEMETRY_RETENTION_HOURS: 72,
      EVENT_RETENTION_DAYS: 7,
    });
    expect(() => parseServerEnv({ DATABASE_URL: url, TAG_POLL_MS: "10" })).toThrowError(
      new EnvironmentError(["TAG_POLL_MS"]),
    );
    expect(() => parseServerEnv({ DATABASE_URL: url, EVENT_RETENTION_DAYS: "0" })).toThrowError(
      new EnvironmentError(["EVENT_RETENTION_DAYS"]),
    );
  });

  it("takes the simulator timing as numbers within limits", () => {
    expect(
      parseServerEnv({ DATABASE_URL: url, SIMULATION_TICK_MS: "50", SIMULATION_SNAPSHOT_MS: "5000" }),
    ).toMatchObject({ SIMULATION_TICK_MS: 50, SIMULATION_SNAPSHOT_MS: 5000 });
    expect(() => parseServerEnv({ DATABASE_URL: url, SIMULATION_TICK_MS: "5" })).toThrowError(
      new EnvironmentError(["SIMULATION_TICK_MS"]),
    );
    expect(() => parseServerEnv({ DATABASE_URL: url, SIMULATION_SNAPSHOT_MS: "fast" })).toThrowError(
      new EnvironmentError(["SIMULATION_SNAPSHOT_MS"]),
    );
  });

  it("accepts a unix socket or a TCP proxy as the Docker endpoint and nothing else", () => {
    expect(parseServerEnv({ DATABASE_URL: url, DOCKER_HOST: "tcp://docker-proxy:2375" }).DOCKER_HOST).toBe(
      "tcp://docker-proxy:2375",
    );
    for (const bad of ["ssh://host", "http://host:2375", "/var/run/docker.sock"]) {
      expect(() => parseServerEnv({ DATABASE_URL: url, DOCKER_HOST: bad })).toThrowError(
        new EnvironmentError(["DOCKER_HOST"]),
      );
    }
  });

  it("validates the runtime port range and bind addresses", () => {
    expect(() => parseServerEnv({ DATABASE_URL: url, RUNTIME_PORT_RANGE: "all" })).toThrowError(
      new EnvironmentError(["RUNTIME_PORT_RANGE"]),
    );
    expect(() => parseServerEnv({ DATABASE_URL: url, RUNTIME_BIND_ADDRESSES: "localhost" })).toThrowError(
      new EnvironmentError(["RUNTIME_BIND_ADDRESSES"]),
    );
  });

  it("treats TEST_DATABASE_URL as optional", () => {
    expect(parseServerEnv({ DATABASE_URL: url, TEST_DATABASE_URL: url }).TEST_DATABASE_URL).toBe(url);
  });

  it("names the missing variable", () => {
    expect(() => parseServerEnv({})).toThrowError(new EnvironmentError(["DATABASE_URL"]));
  });

  it("rejects other protocols without leaking the value", () => {
    const bad = "mysql://user:secret@localhost/db";
    try {
      parseServerEnv({ DATABASE_URL: bad });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      expect((error as EnvironmentError).variables).toEqual(["DATABASE_URL"]);
      expect((error as Error).message).not.toContain("secret");
    }
  });
});
