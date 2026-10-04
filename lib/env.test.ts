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
    });
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
