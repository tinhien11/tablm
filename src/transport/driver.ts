import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Page, listTargets, openTab, ensureChrome, CdpError } from "./cdp.js";
import { pageTurn, TurnResult } from "./page-core.js";

export interface SiteSelectors {
  composer: string[];
  send: string[];
  stop: string[];
  generating: string[];
  generatingAbsent?: string[];
  placeholderTexts?: string[];
  thinkingContent?: string[];
  assistant: string[];
  assistantContent: string[];
  turns: string[];
  conversationIdPattern: string;
  stabilityMs: number;
}

export interface SiteConfig {
  id: string;
  label: string;
  hosts: string[];
  newChatUrl: string;
  conversationUrl: (id: string) => string;
  selectors: SiteSelectors;
  defaults: { timeoutMs: number; idleMs: number };
  extSite?: string;
  transport?: "cdp" | "extension";
}

export const SITES: Record<string, SiteConfig> = {
  chatgpt: {
    id: "chatgpt",
    extSite: "chatgpt",
    label: "ChatGPT (chatgpt.com)",
    hosts: ["chatgpt.com", "chat.openai.com"],
    newChatUrl: "https://chatgpt.com/",
    conversationUrl: (id) => `https://chatgpt.com/c/${id}`,
    selectors: {
      composer: ["#prompt-textarea", 'div[contenteditable="true"]', "textarea"],
      send: ['button[data-testid="send-button"]', 'button[aria-label*="Send"]'],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
      generating: [
        '[data-is-streaming="true"]',
        ".result-streaming",
        '[aria-busy="true"]',
        '[data-testid="thinking-indicator"]',
        'li[data-message-role="assistant"]:not([data-message-complete])',
        'li[data-message-role="assistant"][data-message-complete="false"]',
      ],
      assistant: ['[data-message-author-role="assistant"]', 'li[data-message-role="assistant"]'],
      assistantContent: [".markdown", "[data-stream-target]"],
      turns: ["[data-turn-id]"],
      conversationIdPattern: "^/(?:c|uc)/([0-9a-f-]{8,})",
      stabilityMs: 1200,
    },
    // 150s idle: ChatGPT reasoning models can think silently for minutes and
    // the thinking UI may not match the generating selectors above
    defaults: { timeoutMs: 180_000, idleMs: 150_000 },
  },
  kimi: {
    id: "kimi",
    extSite: "kimi",
    label: "Kimi (kimi.ai)",
    hosts: ["kimi.ai", "kimi.com", "www.kimi.ai", "www.kimi.com", "kimi.moonshot.cn"],
    newChatUrl: "https://www.kimi.ai/",
    conversationUrl: (id) => `https://www.kimi.ai/chat/${id}`,
    selectors: {
      composer: [
        "#chat-input",
        'textarea[placeholder]',
        'div[contenteditable="true"]',
        "textarea",
      ],
      send: [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]',
        'button[aria-label*="发送"]',
        'button[type="submit"]',
        'button[class*="send"]',
      ],
      stop: [
        'button[aria-label*="Stop"]',
        'button[aria-label*="stop"]',
        'button[aria-label*="停止"]',
        'button[class*="stop"]',
      ],
      generating: [
        '[class*="loading"]',
        '[class*="generating"]',
        '[class*="typing"]',
        '[aria-busy="true"]',
      ],
      assistant: [
        '[class*="assistant"]',
        '[class*="answer"]',
        '[data-testid*="assistant"]',
      ],
      assistantContent: [],
      turns: [
        '[class*="message-item"]',
        '[class*="chat-item"]',
        '[class*="message-item"]',
        "article",
      ],
      conversationIdPattern: "^/(?:chat|kimi)/([a-zA-Z0-9_-]+)",
      stabilityMs: 1500,
    },
    defaults: { timeoutMs: 110_000, idleMs: 90_000 },
  },
  zai: {
    id: "zai",
    extSite: "glm",
    label: "Z.ai (chat.z.ai)",
    hosts: ["chat.z.ai", "z.ai"],
    newChatUrl: "https://chat.z.ai/",
    conversationUrl: (id) => `https://chat.z.ai/c/${id}`,
    selectors: {
      composer: ["#chat-input", "textarea"],
      send: ["#send-message-button", 'button[class*="sendMessageButton"]', 'button[aria-label*="Send" i]'],
      stop: ['button[aria-label*="Stop" i]', 'button[id*="stop" i]', 'button[class*="stop" i]'],
      generating: ['[aria-busy="true"]', '[class*="typing"]'],
      generatingAbsent: ["#send-message-button"],
      placeholderTexts: ["^thinking\\.\\.\\.?$", "^thought process$", "^thinking$"],
      thinkingContent: ['[class*="thinking-chain"]'],
      assistant: [".chat-assistant"],
      assistantContent: ['.markdown-prose > :not(:has([class*="thinking-chain"])):not([class*="thinking-chain"])'],
      turns: ['div[id^="message-"]'],
      conversationIdPattern: "^/c/([0-9a-f-]{8,})",
      stabilityMs: 1200,
    },
    defaults: { timeoutMs: 110_000, idleMs: 90_000 },
  },
};

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override as T;
  if (typeof base === "object" && base !== null && typeof override === "object") {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out as T;
  }
  return override as T;
}

function configPath(): string {
  return (
    process.env.TABLM_SITES_CONFIG ||
    path.join(os.homedir(), ".tablm", "sites.json")
  );
}

export function loadSiteOverrides(): Record<string, any> {
  const file = configPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function resolveSite(siteId: string): SiteConfig {
  const base = SITES[siteId];
  if (!base) {
    throw new Error(
      `unknown site "${siteId}" (available: ${Object.keys(SITES).join(", ")})`
    );
  }
  const overrides = loadSiteOverrides();
  const o = overrides[siteId] ?? {};
  const selectors = deepMerge({ ...base.selectors }, o.selectors ?? {});
  return {
    ...base,
    ...o,
    conversationUrl: base.conversationUrl,
    selectors,
    defaults: { ...base.defaults, ...(o.defaults ?? {}) },
  };
}

export function siteIds(): string[] {
  return Object.keys(SITES);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function hostMatches(url: string, hosts: string[]): boolean {
  const host = hostOf(url);
  return hosts.some((h) => host === h || host.endsWith("." + h));
}

const pages = new Map<string, Page>();
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next);
  return next;
}

async function requireCdp(): Promise<void> {
  try {
    await listTargets();
    return;
  } catch {}
  await ensureChrome();
  try {
    await listTargets();
  } catch {
    throw new Error(
      `Chrome debug port not reachable at ${process.env.TABLM_CDP_URL || "http://127.0.0.1:9222"} even after auto-launch`
    );
  }
}

async function ensurePage(site: SiteConfig): Promise<Page> {
  const targets = await listTargets();
  const match = targets.find((t) => hostMatches(t.url, site.hosts));
  if (match) {
    const existing = pages.get(match.targetId);
    if (existing) {
      try {
        await existing.evalValue("1");
        return existing;
      } catch {
        existing.dispose();
        pages.delete(match.targetId);
      }
    }
    const page = await Page.attach(match);
    pages.set(match.targetId, page);
    return page;
  }
  const created = await openTab(site.newChatUrl);
  const page = await Page.attach(created);
  pages.set(created.targetId, page);
  await waitForUrl(page, site.newChatUrl);
  return page;
}

async function waitForUrl(page: Page, target: string, timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const u = await page.url().catch(() => "");
    if (u && !u.startsWith("about:")) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function ensureOnSite(page: Page, site: SiteConfig): Promise<void> {
  const u = await page.url().catch(() => "");
  if (!u || u.startsWith("about:")) {
    await page.navigate(site.newChatUrl);
    await waitForUrl(page, site.newChatUrl);
  }
}

function sessionsFile(): string {
  return process.env.TABLM_SESSIONS || path.join(os.homedir(), ".tablm", "sessions.json");
}

const sessions: Record<string, string> = (() => {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(), "utf8"));
  } catch {
    return {};
  }
})();

function rememberSession(key: string, conversationId: string | null): void {
  if (!conversationId) return;
  sessions[key] = conversationId;
  try {
    fs.mkdirSync(path.dirname(sessionsFile()), { recursive: true });
    fs.writeFileSync(sessionsFile(), JSON.stringify(sessions, null, 2));
  } catch {}
}

export interface AskOptions {
  conversationId?: string;
  newChat?: boolean;
  session?: string;
  timeoutS?: number;
}

function gatewayHttp(): string {
  return process.env.TABLM_GATEWAY_HTTP || "http://127.0.0.1:8788";
}

function transportFor(site: SiteConfig): "cdp" | "extension" {
  return site.transport ?? ((process.env.TABLM_TRANSPORT as "cdp" | "extension") || "cdp");
}

async function extAsk(
  site: SiteConfig,
  prompt: string,
  conversation: { mode: string; conversation_id?: string },
  timeoutS: number
): Promise<TurnResult> {
  const r = await fetch(`${gatewayHttp()}/ext/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      site: site.extSite ?? site.id,
      operation: "model.turn",
      prompt,
      conversation,
      timeout_s: Math.ceil(timeoutS / 1000),
    }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    return {
      status: "error",
      text: "",
      conversationId: null,
      error: body.error ?? `extension rpc failed (${r.status})`,
    };
  }
  if (body.type === "job_cancelled") {
    return {
      status: "timeout",
      text: body.text ?? "",
      conversationId: body.conversationId ?? null,
      error: "cancelled: " + (body.reason ?? "unknown"),
    };
  }
  if (body.type === "job_error") {
    return { status: "error", text: "", conversationId: null, error: body.error ?? "extension job failed" };
  }
  return {
    status: "done",
    text: body.text ?? "",
    conversationId: body.conversationId ?? null,
  };
}

export async function askSite(
  siteId: string,
  prompt: string,
  opts: AskOptions = {}
): Promise<TurnResult & { site: string; reused: boolean }> {
  const site = resolveSite(siteId);
  const key = opts.session ? `${siteId}:${opts.session}` : siteId;
  if (transportFor(site) === "extension") {
    let convId = opts.conversationId;
    let reused = false;
    if (!convId && !opts.newChat) {
      convId = sessions[key] ?? null;
      reused = Boolean(convId);
    }
    const conversation = convId
      ? { mode: "continue", conversation_id: convId }
      : { mode: "fresh" };
    const timeoutS = Math.max(15, Math.ceil((opts.timeoutS ?? site.defaults.timeoutMs / 1000)));
    const result = await extAsk(site, prompt, conversation, timeoutS);
    if (result.conversationId) rememberSession(key, result.conversationId);
    return { ...result, site: siteId, reused };
  }
  return withLock(key, async () => {
    await requireCdp();
    const page = await ensurePage(site);
    let convId = opts.conversationId;
    let reused = false;
    if (!convId && !opts.newChat) {
      convId = sessions[key] ?? null;
      reused = Boolean(convId);
    }
    if (convId) {
      const target = site.conversationUrl(convId);
      if (!(await page.url()).includes(convId)) {
        await page.navigate(target);
      }
    } else {
      await page.navigate(site.newChatUrl);
      await waitForUrl(page, site.newChatUrl);
    }
    const timeoutMs = Math.max(10_000, (opts.timeoutS ?? site.defaults.timeoutMs / 1000) * 1000);
    const cfg = {
      prompt,
      timeoutMs,
      idleMs: site.defaults.idleMs,
      selectors: site.selectors,
    };
    const expression = `(${pageTurn.toString()})(${JSON.stringify(cfg)})`;
    let result: TurnResult;
    try {
      result = await page.evalValue<TurnResult>(expression);
    } catch (e) {
      if (e instanceof CdpError && /context|destroyed|navigat|closed|target/i.test(e.message)) {
        result = await page.evalValue<TurnResult>(expression);
      } else {
        throw e;
      }
    }
    if (result.status === "error" && reused && /composer not found/i.test(result.error ?? "")) {
      await page.navigate(site.newChatUrl);
      result = await page.evalValue<TurnResult>(expression);
      reused = false;
    }
    if (result.conversationId) rememberSession(key, result.conversationId);
    return { ...result, site: siteId, reused };
  });
}

export async function listSites(): Promise<unknown> {
  const out: Record<string, unknown>[] = [];
  let bridgeUp = false;
  try {
    const r = await fetch(`${gatewayHttp()}/ext/status`, { signal: AbortSignal.timeout(3000) });
    bridgeUp = (await r.json() as any).connected === true;
  } catch {}
  out.push({ extensionBridge: bridgeUp ? "connected" : "disconnected" });
  let cdpAvailable = true;
  try {
    await listTargets();
  } catch {
    cdpAvailable = false;
  }
  for (const site of Object.values(SITES)) {
    if (transportFor(site) === "extension") {
      out.push({
        id: site.id,
        label: site.label,
        transport: "extension",
        ready: bridgeUp,
      });
      continue;
    }
    if (!cdpAvailable) {
      out.push({ id: site.id, label: site.label, transport: "cdp", error: "chrome debug port not reachable" });
      continue;
    }
    const targets = await listTargets();
    const tab = targets.find((t) => hostMatches(t.url, site.hosts));
    if (!tab) {
      out.push({ id: site.id, label: site.label, tabOpen: false });
      continue;
    }
    try {
      const page = await ensurePage(site);
      const health = await page.evalValue<any>(`(() => {
        const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const firstVisible = (sels) => {
          for (const s of sels) { for (const el of document.querySelectorAll(s)) if (vis(el)) return true; }
          return false;
        };
        const sels = ${JSON.stringify(site.selectors)};
        let conversationId = null;
        try {
          const m = location.pathname.match(new RegExp(sels.conversationIdPattern));
          if (m) conversationId = m[1] || m[0];
        } catch {}
        return {
          url: location.href,
          composerVisible: firstVisible(sels.composer),
          sendVisible: firstVisible(sels.send),
          busy: firstVisible(sels.stop) || sels.generating.some((s) => document.querySelector(s) !== null),
          conversationId
        };
      })()`);
      out.push({
        id: site.id,
        label: site.label,
        tabOpen: true,
        ...health,
        loggedInGuess: health.composerVisible,
      });
    } catch (e) {
      out.push({
        id: site.id,
        label: site.label,
        tabOpen: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

export async function inspectDom(
  siteId: string,
  selector?: string
): Promise<unknown> {
  const site = resolveSite(siteId);
  await requireCdp();
  const page = await ensurePage(site);
  await ensureOnSite(page, site);
  const expression = `(() => {
    const grab = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: typeof el.className === "string" && el.className ? el.className : undefined,
      testid: el.getAttribute("data-testid") || undefined,
      aria: el.getAttribute("aria-label") || undefined,
      contenteditable: el.getAttribute("contenteditable") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      disabled: el.disabled || undefined,
      text: (((el.innerText || el.textContent || "") + "").trim().slice(0, 120)) || undefined
    });
    const out = { url: location.href, title: document.title };
    const sel = ${JSON.stringify(selector ?? null)};
    if (sel) {
      out.selector = sel;
      out.matches = [...document.querySelectorAll(sel)].slice(0, 25).map(grab);
    }
    out.composerCandidates = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')]
      .filter(el => el.offsetWidth || el.offsetHeight).slice(0, 10).map(grab);
    out.buttons = [...document.querySelectorAll("button")]
      .filter(el => el.offsetWidth || el.offsetHeight).slice(0, 50).map(grab);
    return out;
  })()`;
  return page.evalValue(expression);
}

export async function screenshotSite(siteId: string): Promise<string> {
  const site = resolveSite(siteId);
  await requireCdp();
  const page = await ensurePage(site);
  await ensureOnSite(page, site);
  return page.screenshot();
}
