import { describe, expect, it } from "vitest";
import { EnvironmentError, parseServerEnv } from "./env";

const url = "postgresql://user:secret@localhost:5432/zfactory";

describe("server environment contract", () => {
  it("accepts a PostgreSQL connection string", () => {
    expect(parseServerEnv({ DATABASE_URL: url })).toEqual({ DATABASE_URL: url });
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
