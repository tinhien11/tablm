import CDP from "chrome-remote-interface";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cdpOpts = (() => {
  const raw = process.env.WEB2MODEL_CDP_URL || "http://127.0.0.1:9222";
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: Number(u.port || 9222),
    secure: u.protocol === "https:",
  };
})();

const CHROME_CANDIDATES = [
  process.env.WEB2MODEL_CHROME_BIN,
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "brave-browser",
  "microsoft-edge",
].filter(Boolean) as string[];

function chromeProfileDir(): string {
  return process.env.WEB2MODEL_CHROME_PROFILE || path.join(os.homedir(), ".web2model", "chrome-profile");
}

function findChromeBin(): string | null {
  for (const bin of CHROME_CANDIDATES) {
    if (bin.includes("/")) {
      if (fs.existsSync(bin)) return bin;
      continue;
    }
    for (const dir of (process.env.PATH || "").split(":")) {
      try {
        const p = path.join(dir, bin);
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  }
  return null;
}

async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`http://${cdpOpts.host}:${cdpOpts.port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureChrome(): Promise<void> {
  if (await cdpAlive()) return;
  const bin = findChromeBin();
  if (!bin) {
    throw new Error(
      `CDP not reachable at ${process.env.WEB2MODEL_CDP_URL || "http://127.0.0.1:9222"} and no Chrome binary found in PATH`
    );
  }
  const profile = chromeProfileDir();
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    bin,
    [
      `--remote-debugging-port=${cdpOpts.port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
    }
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await cdpAlive()) return;
  }
  throw new Error(`Chrome launched but CDP port ${cdpOpts.port} did not open within 20s`);
}

export class CdpError extends Error {}

export interface Target {
  targetId: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

const CDPAny = CDP as any;

export async function listTargets(): Promise<Target[]> {
  const targets = (await CDPAny.List(cdpOpts)) as Target[];
  return targets.filter((t) => t.type === "page");
}

export async function openTab(url: string): Promise<Target> {
  return (await CDPAny.New({ ...cdpOpts, url })) as Target;
}

export class Page {
  private client: any;
  readonly targetId: string;

  private constructor(client: any, targetId: string) {
    this.client = client;
    this.targetId = targetId;
  }

  static async attach(target: Target): Promise<Page> {
    const client = target.webSocketDebuggerUrl
      ? await CDPAny({ target: target.webSocketDebuggerUrl })
      : await CDPAny({ ...cdpOpts, target });
    await client.Page.enable();
    await client.Runtime.enable();
    return new Page(client, target.targetId);
  }

  async evalValue<T = unknown>(expression: string): Promise<T> {
    const res = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      const detail =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "unknown error";
      throw new CdpError(`page evaluate failed: ${detail}`);
    }
    return res?.result?.value as T;
  }

  async navigate(url: string, loadTimeoutMs = 20000): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const handler = () => {
        this.client.off("Page.loadEventFired", handler);
        resolve();
      };
      this.client.on("Page.loadEventFired", handler);
    });
    await this.client.Page.navigate({ url });
    await Promise.race([loaded, sleep(loadTimeoutMs)]);
  }

  async url(): Promise<string> {
    return (await this.evalValue<string>("location.href")) ?? "";
  }

  async screenshot(): Promise<string> {
    const res = await this.client.Page.captureScreenshot({ format: "png" });
    return res.data as string;
  }

  dispose(): void {
    try {
      this.client.close();
    } catch {}
  }
}
