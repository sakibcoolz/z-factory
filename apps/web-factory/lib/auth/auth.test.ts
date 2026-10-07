import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { can, ROLES } from "@/lib/auth/roles";
import { parseServerEnv } from "@/lib/env";

describe("passwords", () => {
  it("hashes with a salt and verifies in constant time", async () => {
    const first = await hashPassword("correct horse battery");
    const second = await hashPassword("correct horse battery");
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword("correct horse battery", first)).toBe(true);
    expect(await verifyPassword("correct horse batterY", first)).toBe(false);
    expect(await verifyPassword("anything", "md5$nonsense")).toBe(false);
    expect(passwordProblem("short")).toMatch(/12/);
    expect(passwordProblem("long enough pass")).toBeNull();
  });
});

describe("roles", () => {
  it("orders viewer, operator and admin", () => {
    expect(
      ROLES.map((role) => [
        can(role, "view"),
        can(role, "command"),
        can(role, "manageSites"),
        can(role, "manageUsers"),
      ]),
    ).toEqual([
      [true, false, false, false],
      [true, true, false, false],
      [true, true, true, true],
    ]);
    expect(can(null, "view")).toBe(false);
  });
});

describe("environment", () => {
  const base = { WEB_FACTORY_DATABASE_URL: "postgresql://u:p@localhost:5432/web_factory", AUTH_SECRET: "x".repeat(32) };
  it("needs a database and a long secret, and keeps MQTT credentials out of URLs", () => {
    expect(parseServerEnv(base).WEB_FACTORY_MQTT_URL).toBeUndefined();
    expect(() => parseServerEnv({ ...base, AUTH_SECRET: "short" })).toThrow("AUTH_SECRET");
    expect(() => parseServerEnv({ AUTH_SECRET: base.AUTH_SECRET })).toThrow("WEB_FACTORY_DATABASE_URL");
    expect(parseServerEnv({ ...base, WEB_FACTORY_MQTT_URL: "mqtts://broker:8883" }).WEB_FACTORY_MQTT_URL).toBe(
      "mqtts://broker:8883",
    );
    expect(() => parseServerEnv({ ...base, WEB_FACTORY_MQTT_URL: "mqtt://user:secret@broker:1883" })).toThrow(
      "WEB_FACTORY_MQTT_URL",
    );
    // The error names the variable, never its value.
    expect(() => parseServerEnv({ ...base, AUTH_SECRET: "tooshort-secret" })).not.toThrow(/tooshort-secret/);
  });
});
