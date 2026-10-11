import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * The application as a person reaches it: `next start` of the production build, on a free
 * port, against the integration-test database and with a local owner (TASK-1008). The
 * browser agent talks to this server only.
 */

export type AppServer = {
  baseUrl: string;
  /** Everything the server printed so far, for a failure report. */
  output(): string;
  stop(): Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function startAppServer(options: {
  databaseUrl: string;
  ownerId: string;
  cwd?: string;
}): Promise<AppServer> {
  const cwd = options.cwd ?? process.cwd();
  if (!existsSync(join(cwd, ".next", "BUILD_ID"))) {
    throw new Error("No production build in .next: run `npm run build` before the browser-agent test.");
  }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    process.execPath,
    [join(cwd, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        DATABASE_URL: options.databaseUrl,
        LOCAL_OWNER_ID: options.ownerId,
        RUNTIME_SECRET: process.env.RUNTIME_SECRET ?? "browser-agent-test-runtime-secret-never-for-production",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode}:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/llm-index.md`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`next start did not answer within 90 s:\n${output}`);
    await sleep(500);
  }

  return {
    baseUrl,
    output: () => output,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}
