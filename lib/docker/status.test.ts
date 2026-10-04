// @vitest-environment node
import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { getDockerEngineStatus } from "./status";

const engine = (version: () => Promise<unknown>) => ({ version }) as unknown as Docker;

describe("docker engine status", () => {
  it("reports the engine version when it answers", async () => {
    expect(await getDockerEngineStatus(engine(async () => ({ Version: "29.7.2" })))).toEqual({
      reachable: true,
      version: "29.7.2",
    });
  });

  it("reports unreachable instead of throwing", async () => {
    const failing = engine(async () => {
      throw Object.assign(new Error("connect ENOENT /var/run/docker.sock"), { code: "ENOENT" });
    });
    expect(await getDockerEngineStatus(failing)).toEqual({ reachable: false });
  });

  it("gives up on an engine that never answers", async () => {
    const hanging = engine(() => new Promise(() => {}));
    expect(await getDockerEngineStatus(hanging)).toEqual({ reachable: false });
  }, 5000);
});
