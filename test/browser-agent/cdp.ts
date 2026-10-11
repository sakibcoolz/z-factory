import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A minimal driver for a real Chromium over the DevTools protocol (TASK-1008). It knows
 * nothing about Z-Factory: it opens pages, runs JavaScript in them and takes screenshots.
 * The browser agent built on it reads and operates the application the way a person's
 * browser does, with no other channel to the server.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Chromium to drive: `CHROME_BIN`, else a browser Playwright cached, else one on the PATH. */
export function findChromium(): string | undefined {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache).sort().reverse()) {
      const found = [
        join(cache, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        join(cache, entry, "chrome-linux", "chrome"),
      ].find((path) => existsSync(path));
      if (found) return found;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    for (const name of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return undefined;
}

type Message = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
};

type Evaluated<T> = {
  result: { type: string; value?: T };
  exceptionDetails?: { text: string; exception?: { description?: string } };
};

export class Browser {
  private constructor(
    private readonly child: ChildProcess,
    readonly port: number,
    private readonly profile: string,
  ) {}

  /** Starts Chromium headless on a port of its choosing and waits for its DevTools endpoint. */
  static async launch(binary: string): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), "zf-browser-agent-"));
    const child = spawn(
      binary,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--window-size=1280,900",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const port = await new Promise<number>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(
        () => reject(new Error(`Chromium did not announce its DevTools port:\n${text}`)),
        20_000,
      );
      child.stderr!.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Chromium exited with ${code}:\n${text}`));
      });
    });
    return new Browser(child, port, profile);
  }

  async newPage(): Promise<Page> {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" });
    const target = (await response.json()) as { id: string; webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("The DevTools socket of the new tab did not open."));
    });
    const page = new Page(socket, target.id, this.port);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return page;
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 5000);
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        this.child.kill("SIGTERM");
      });
    }
    rmSync(this.profile, { recursive: true, force: true });
  }
}

export class Page {
  private seq = 0;
  private loads = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly socket: WebSocket,
    readonly targetId: string,
    private readonly port: number,
  ) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${message.error.message}`));
        else waiter.resolve(message.result);
      } else if (message.method === "Page.loadEventFired") {
        this.loads += 1;
      }
    };
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.seq += 1;
    const id = this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Loads a URL and waits for the document and its hydration. */
  async goto(url: string): Promise<void> {
    const before = this.loads;
    await this.send("Page.navigate", { url });
    const deadline = Date.now() + 30_000;
    while (this.loads === before) {
      if (Date.now() > deadline) throw new Error(`${url} did not finish loading.`);
      await sleep(50);
    }
    await this.waitFor("document.readyState === 'complete'", { what: `${url} to be complete` });
    // React hydrates after the load event; controls answer only once it has.
    await sleep(500);
  }

  /** Runs an expression in the page and returns its JSON value; a thrown error is rethrown here. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const evaluated = await this.send<Evaluated<T>>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) {
      throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
    }
    return evaluated.result.value as T;
  }

  /** Polls an expression until it is truthy and returns that value. */
  async waitFor<T = unknown>(expression: string, options: { timeout?: number; what?: string } = {}): Promise<T> {
    const deadline = Date.now() + (options.timeout ?? 15_000);
    for (;;) {
      const value = await this.eval<T>(expression);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${options.what ?? expression}`);
      await sleep(150);
    }
  }

  async screenshot(path: string): Promise<void> {
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(shot.data, "base64"));
  }

  /** Closes the tab, not only the socket: a tab left open keeps its connections to the server. */
  async close(): Promise<void> {
    this.socket.close();
    await fetch(`http://127.0.0.1:${this.port}/json/close/${this.targetId}`);
  }
}
