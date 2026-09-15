#!/usr/bin/env node
import { exec as execCb } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { openTab, Page as CdpPage, listTargets, ensureChrome, closeTab } from "./cdp.js";

const GATEWAY = process.env.TABLM_GATEWAY_URL || "http://127.0.0.1:8788";
const AUTH_TOKEN = process.env.TABLM_AUTH_TOKEN || "tablm";
const MODEL = process.env.TABLM_MODEL || "web-zai";
const MAX_TURNS = Number(process.env.TABLM_MAX_TURNS || 50);

// ---------- CLI session persistence ----------
const SESSIONS_DIR = path.join(homedir(), ".tablm", "cli-sessions");

interface CliSession {
  id: string;
  created: string;
  updated: string;
  cwd: string;
  model: string;
  prompt: string;
  messages: any[];
}

function loadSession(id: string): CliSession | null {
  const file = path.join(SESSIONS_DIR, `${id}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function saveSession(session: CliSession): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  session.updated = new Date().toISOString();
  writeFileSync(path.join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
}

function listSessions(): CliSession[] {
  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  } catch {
    return [];
  }
}

function genSessionId(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
}

// ---------- Scratch tab manager (1 tab per CLI session) ----------
let scratchPage: CdpPage | null = null;

async function getScratchPage(url: string): Promise<CdpPage> {
  if (scratchPage) {
    try {
      await scratchPage.evalValue("1");
      await scratchPage.navigate(url);
      return scratchPage;
    } catch {
      try { await scratchPage.close(); } catch {}
      scratchPage = null;
    }
  }
  await ensureChrome();
  const target = await openTab(url);
  scratchPage = await CdpPage.attach(target);
  await scratchPage.navigate(url);
  return scratchPage;
}

async function closeScratchPage(): Promise<void> {
  if (scratchPage) {
    try { await scratchPage.close(); } catch {}
    scratchPage = null;
  }
}

// ---------- Tools ----------
interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  run: (input: any) => Promise<string>;
}

const tools: Tool[] = [
  {
    name: "Bash",
    description: "Execute a shell command. Returns stdout+stderr. Use for any system operation.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    run: async (input) => {
      return new Promise((resolve) => {
        execCb(input.command, { maxBuffer: 1024 * 1024 * 10, timeout: 120000 }, (err, stdout, stderr) => {
          let out = "";
          if (stdout) out += stdout;
          if (stderr) out += (out ? "\n[stderr]\n" : "[stderr]\n") + stderr;
          if (err && !stdout && !stderr) out += `[error] ${err.message}`;
          resolve(out.slice(0, 20000) || "(no output)");
        });
      });
    },
  },
  {
    name: "Read",
    description: "Read a file. Returns full contents.",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    run: async (input) => {
      try {
        return readFileSync(input.file_path, "utf8").slice(0, 50000);
      } catch (e: any) {
        return `[error] ${e.message}`;
      }
    },
  },
  {
    name: "Write",
    description: "Write content to a file. For content over ~300 chars, use the payload form: set content to \"@payload:content\" and output the raw text between @@TABLM t1 content <<'EOF' and @@TABLM_END t1 after the JSON (no escaping needed).",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] },
    run: async (input) => {
      try {
        writeFileSync(input.file_path, input.content);
        return `wrote ${input.content.length} chars to ${input.file_path}`;
      } catch (e: any) {
        return `[error] ${e.message}`;
      }
    },
  },
  {
    name: "Edit",
    description: "Replace old_string with new_string in a file. Must match exactly once.",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] },
    run: async (input) => {
      try {
        const content = readFileSync(input.file_path, "utf8");
        const count = content.split(input.old_string).length - 1;
        if (count === 0) return `[error] old_string not found`;
        if (count > 1) return `[error] old_string found ${count} times - must be unique`;
        const updated = content.replace(input.old_string, input.new_string);
        writeFileSync(input.file_path, updated);
        return `edited ${input.file_path}`;
      } catch (e: any) {
        return `[error] ${e.message}`;
      }
    },
  },
  {
    name: "Grep",
    description: "Search file contents with regex. Returns matching lines with file:line:content.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "directory or file to search" }, glob: { type: "string" } }, required: ["pattern"] },
    run: async (input) => {
      return new Promise((resolve) => {
        const globFlag = input.glob ? `--include='${input.glob}'` : "";
        const cmd = `rg -n -- '${input.pattern.replace(/'/g, "'\\''")}' ${globFlag} '${input.path || "."}' 2>/dev/null | head -100`;
        execCb(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
          resolve(stdout || "(no matches)");
        });
      });
    },
  },
  {
    name: "Glob",
    description: "Find files by glob pattern. Returns matching file paths.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    run: async (input) => {
      return new Promise((resolve) => {
        const cmd = `find '${input.path || "."}' -path '${input.pattern}' -type f 2>/dev/null | head -100`;
        execCb(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
          resolve(stdout || "(no files)");
        });
      });
    },
  },
  {
    name: "WebSearch",
    description: "Search the web via Google using Chrome DevTools Protocol. Returns top results with title, URL, and snippet. Use for looking up docs, APIs, error messages, or current information.",
    input_schema: { type: "object", properties: { query: { type: "string" }, num_results: { type: "number", description: "max results (default 10)" } }, required: ["query"] },
    run: async (input) => {
      const query = encodeURIComponent(input.query);
      const num = input.num_results || 10;
      try {
        const url = `https://www.google.com/search?q=${query}&num=${num}&hl=en&lr=en`;
        const page = await getScratchPage(url);
        await new Promise((r) => setTimeout(r, 3000));
        const results = await page.evalValue<any[]>(`(() => {
          // Try to dismiss consent dialog if present
          const consentBtn = document.querySelector('button#L2AGLb, button#W0wtkc, div[role="button"]');
          if (consentBtn && /accept|agree|reject|decline/i.test(consentBtn.textContent)) consentBtn.click();
          const items = [];
          // Google search result selectors (2024-2026 layout)
          const blocks = document.querySelectorAll('div.g, div[data-sokoban-container] > div, div.MjjYud > div');
          for (const block of blocks) {
            if (items.length >= ${num}) break;
            const link = block.querySelector('a[href]');
            if (!link) continue;
            const href = link.href;
            if (!href || href.startsWith('https://www.google.com/') || href.startsWith('https://maps.google.com/') || href.includes('google.com/search')) continue;
            const titleEl = block.querySelector('h3, [role="heading"]');
            const title = titleEl ? titleEl.textContent.trim() : '';
            const snippetEl = block.querySelector('div[data-sncf], div[data-snpf], span.aCOpRe, div.VwiC3b, div.IsZvec, div[style*="-webkit-line-clamp"]');
            const snippet = snippetEl ? snippetEl.textContent.trim().slice(0, 300) : '';
            if (title || href) items.push({ title, url: href, snippet });
          }
          // Fallback: if no results, grab all links with h3
          if (items.length === 0) {
            document.querySelectorAll('a:has(h3)').forEach(a => {
              if (items.length >= ${num}) return;
              const href = a.href;
              if (!href || href.startsWith('https://www.google.com/')) return;
              const h3 = a.querySelector('h3');
              items.push({ title: h3 ? h3.textContent.trim() : '', url: href, snippet: '' });
            });
          }
          return items;
        })()`);
        if (!results || results.length === 0) {
          // Fallback to DuckDuckGo HTML
          const ddgUrl = `https://html.duckduckgo.com/html/?q=${query}`;
          const ddgPage = await getScratchPage(ddgUrl);
          await new Promise((r) => setTimeout(r, 3000));
          const ddgResults = await ddgPage.evalValue<any[]>(`(() => {
            const items = [];
            document.querySelectorAll('.result, div.web-result').forEach(block => {
              if (items.length >= ${num}) return;
              const link = block.querySelector('a.result__a, a[href]');
              if (!link) return;
              const title = link.textContent.trim();
              const href = link.href;
              const snippetEl = block.querySelector('.result__snippet, a.result__snippet');
              const snippet = snippetEl ? snippetEl.textContent.trim().slice(0, 300) : '';
              if (title) items.push({ title, url: href, snippet });
            });
            return items;
          })()`);
          if (ddgResults && ddgResults.length > 0) {
            return ddgResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
          }
          return "(no search results found)";
        }
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      } catch (e: any) {
        return `[error] web search failed: ${e.message}`;
      }
    },
  },
  {
    name: "WebFetch",
    description: "Fetch a web page and extract its text content via Chrome DevTools Protocol. Use for reading documentation pages, API references, or any URL. Returns the page text (truncated to 10000 chars).",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: async (input) => {
      try {
        const page = await getScratchPage(input.url);
        await new Promise((r) => setTimeout(r, 3000));
        const text = await page.evalValue<string>(`(() => {
          document.querySelectorAll('script, style, nav, footer, header, aside').forEach(el => el.remove());
          return document.body ? document.body.innerText.slice(0, 10000) : '(empty page)';
        })()`);
        return text || "(empty page)";
      } catch (e: any) {
        return `[error] web fetch failed: ${e.message}`;
      }
    },
  },
  {
    name: "BrowserNavigate",
    description: "Navigate the browser tab to a URL. Use for opening any web page (docs, dashboards, login pages, APIs). Returns the page title and URL after load.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: async (input) => {
      try {
        const page = await getScratchPage(input.url);
        await new Promise((r) => setTimeout(r, 2000));
        const info = await page.evalValue<string>(`JSON.stringify({ url: location.href, title: document.title })`);
        return info;
      } catch (e: any) {
        return `[error] navigate failed: ${e.message}`;
      }
    },
  },
  {
    name: "BrowserSnapshot",
    description: "Get a text snapshot of the current page: visible text content, all interactive elements (links, buttons, inputs) with their selectors. Use to understand page structure before clicking or filling.",
    input_schema: { type: "object", properties: { selector: { type: "string", description: "optional CSS selector to scope the snapshot to a specific element" } }, required: [] },
    run: async (input) => {
      try {
        if (!scratchPage) return "[error] no page open - use BrowserNavigate first";
        const sel = input.selector || "body";
        const snapshot = await scratchPage.evalValue<string>(`(() => {
          const root = document.querySelector('${sel}') || document.body;
          const lines = [];
          // Grab visible text
          const text = root.innerText.slice(0, 5000);
          lines.push("=== TEXT ===");
          lines.push(text);
          // Grab interactive elements
          lines.push("\\n=== INTERACTIVE ELEMENTS ===");
          const els = root.querySelectorAll('a, button, input, textarea, select, [role="button"], [onclick]');
          let count = 0;
          for (const el of els) {
            if (count >= 100) { lines.push("... (truncated)"); break; }
            const tag = el.tagName.toLowerCase();
            const id = el.id ? '#' + el.id : '';
            const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0, 3).join('.') : '';
            const type = el.getAttribute('type') ? '[type=' + el.getAttribute('type') + ']' : '';
            const name = el.getAttribute('name') ? '[name=' + el.getAttribute('name') + ']' : '';
            const text2 = (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().slice(0, 60);
            const selector = tag + id + cls + type + name;
            lines.push(count + ': ' + selector + ' -> "' + text2 + '"');
            count++;
          }
          return lines.join('\\n');
        })()`);
        return snapshot || "(empty page)";
      } catch (e: any) {
        return `[error] snapshot failed: ${e.message}`;
      }
    },
  },
  {
    name: "BrowserClick",
    description: "Click an element on the page by CSS selector. Use after BrowserSnapshot to find the selector. Returns the result text or error.",
    input_schema: { type: "object", properties: { selector: { type: "string", description: "CSS selector for the element to click (e.g. 'button#submit', 'a[href=\"/login\"]')" } }, required: ["selector"] },
    run: async (input) => {
      try {
        if (!scratchPage) return "[error] no page open - use BrowserNavigate first";
        const result = await scratchPage.evalValue<string>(`(() => {
          const el = document.querySelector('${input.selector.replace(/'/g, "\\'")}');
          if (!el) return '[error] element not found: ${input.selector.replace(/'/g, "\\'")}';
          el.click();
          return 'clicked: ${input.selector.replace(/'/g, "\\'")}';
        })()`);
        await new Promise((r) => setTimeout(r, 1000));
        return result;
      } catch (e: any) {
        return `[error] click failed: ${e.message}`;
      }
    },
  },
  {
    name: "BrowserFill",
    description: "Type text into an input or textarea by CSS selector. Use for filling forms, search boxes, login fields. Returns confirmation.",
    input_schema: { type: "object", properties: { selector: { type: "string", description: "CSS selector for the input element" }, value: { type: "string", description: "text to type into the field" } }, required: ["selector", "value"] },
    run: async (input) => {
      try {
        if (!scratchPage) return "[error] no page open - use BrowserNavigate first";
        const result = await scratchPage.evalValue<string>(`(() => {
          const el = document.querySelector('${input.selector.replace(/'/g, "\\'")}');
          if (!el) return '[error] element not found: ${input.selector.replace(/'/g, "\\'")}';
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          const setter = el.tagName === 'TEXTAREA' ? nativeTextAreaValueSetter : nativeInputValueSetter;
          if (setter) setter.call(el, ${JSON.stringify(input.value)});
          else el.value = ${JSON.stringify(input.value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'filled: ${input.selector.replace(/'/g, "\\'")} with ${input.value.length} chars';
        })()`);
        return result;
      } catch (e: any) {
        return `[error] fill failed: ${e.message}`;
      }
    },
  },
  {
    name: "BrowserScreenshot",
    description: "Take a screenshot of the current page and save it to a file. Returns the file path. Use to see what the page looks like (login walls, captchas, visual layout).",
    input_schema: { type: "object", properties: { path: { type: "string", description: "file path to save the screenshot (default: /tmp/tablm-screenshot.png)" } }, required: [] },
    run: async (input) => {
      try {
        if (!scratchPage) return "[error] no page open - use BrowserNavigate first";
        const data = await scratchPage.screenshot();
        const filePath = input.path || "/tmp/tablm-screenshot.png";
        const { writeFileSync } = await import("node:fs");
        writeFileSync(filePath, Buffer.from(data, "base64"));
        return `screenshot saved to ${filePath} (${Math.round(data.length * 3/4 / 1024)}KB)`;
      } catch (e: any) {
        return `[error] screenshot failed: ${e.message}`;
      }
    },
  },
  {
    name: "BrowserEval",
    description: "Evaluate JavaScript on the current page and return the result. Use for advanced interactions: reading computed styles, extracting data from SPAs, calling page APIs, waiting for dynamic content.",
    input_schema: { type: "object", properties: { code: { type: "string", description: "JavaScript expression to evaluate (must return a value)" } }, required: ["code"] },
    run: async (input) => {
      try {
        if (!scratchPage) return "[error] no page open - use BrowserNavigate first";
        const result = await scratchPage.evalValue<string>(input.code);
        return typeof result === "string" ? result : JSON.stringify(result);
      } catch (e: any) {
        return `[error] eval failed: ${e.message}`;
      }
    },
  },
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

// ---------- API (streaming) ----------
interface StreamResult {
  content: any[];
  stop_reason: string;
}

async function callGateway(messages: any[], useTools: boolean, model: string = MODEL): Promise<StreamResult> {
  const body: any = {
    model,
    max_tokens: 8192,
    messages,
    stream: true,
  };
  if (useTools) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
  const res = await fetch(`${GATEWAY}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": AUTH_TOKEN,
      authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`gateway ${res.status}: ${text}`);
  }

  const content: any[] = [];
  let stopReason = "end_turn";
  const blocks: Record<number, any> = {};
  let textStarted = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const eventLine = chunk.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(7).trim();
      let data: any;
      try { data = JSON.parse(dataLine.slice(5)); } catch { continue; }

      if (event === "content_block_start") {
        const cb = data.content_block;
        blocks[data.index] = { type: cb.type, text: "", thinking: "", name: cb.name, id: cb.id, input: "" };
        if (cb.type === "text" && !textStarted) {
          textStarted = true;
          process.stderr.write("[model] ");
        }
      } else if (event === "content_block_delta") {
        const b = blocks[data.index];
        if (!b) continue;
        const d = data.delta;
        if (d.type === "text_delta") {
          b.text += d.text;
          process.stderr.write(d.text);
        } else if (d.type === "thinking_delta") {
          b.thinking += d.thinking;
        } else if (d.type === "input_json_delta") {
          b.input += d.partial_json;
        }
      } else if (event === "content_block_stop") {
        const b = blocks[data.index];
        if (!b) continue;
        if (b.type === "text") {
          content.push({ type: "text", text: b.text });
          process.stderr.write("\n");
        } else if (b.type === "tool_use") {
          let input: any = {};
          try { input = JSON.parse(b.input || "{}"); } catch {}
          content.push({ type: "tool_use", id: b.id, name: b.name, input });
          process.stderr.write(`\n[tool_use ${b.name}]\n`);
        } else if (b.type === "thinking") {
          content.push({ type: "thinking", thinking: b.thinking, signature: "tablm" });
        }
      } else if (event === "message_delta") {
        if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      }
    }
  }

  return { content, stop_reason: stopReason };
}

// ---------- Session compaction ----------
const COMPACT_THRESHOLD_CHARS = 50000; // compact when messages[] exceeds this
const COMPACT_KEEP_RECENT = 6; // keep last N messages after compaction

function messagesCharCount(messages: any[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") total += block.text?.length ?? 0;
        else if (block.type === "tool_use") total += JSON.stringify(block.input ?? {}).length;
        else if (block.type === "tool_result") total += typeof block.content === "string" ? block.content.length : JSON.stringify(block.content ?? "").length;
      }
    }
  }
  return total;
}

async function compactSession(session: CliSession, messages: any[]): Promise<void> {
  const totalChars = messagesCharCount(messages);
  if (totalChars < COMPACT_THRESHOLD_CHARS) return;

  process.stderr.write(`\n[compact] session too long (${totalChars} chars) - compacting + new z.ai chat\n`);

  // Build summary of old messages
  const oldMessages = messages.slice(0, -COMPACT_KEEP_RECENT);
  const summaryParts: string[] = [];
  for (const msg of oldMessages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      summaryParts.push(`User: ${msg.content.slice(0, 200)}`);
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "text" && b.text) summaryParts.push(`Assistant: ${b.text.slice(0, 200)}`);
        else if (b.type === "tool_use") summaryParts.push(`Assistant called ${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 100)})`);
      }
    } else if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "tool_result") {
          const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          summaryParts.push(`Tool result: ${c.slice(0, 200)}`);
        }
      }
    }
  }

  const summary = `[Session compacted. Previous conversation summary:\n${summaryParts.join("\n")}\nEnd of summary. Continue from here.]`;

  // Keep last few messages + prepend summary
  const recent = messages.slice(-COMPACT_KEEP_RECENT);
  messages.length = 0;
  messages.push({ role: "user", content: summary });
  messages.push(...recent);

  // Clear z.ai session so gateway starts fresh chat
  try {
    const sessionsFile = path.join(homedir(), ".tablm", "sessions.json");
    writeFileSync(sessionsFile, "{}");
  } catch {}

  process.stderr.write(`[compact] done - ${messages.length} messages, ${messagesCharCount(messages)} chars, new z.ai chat\n`);
  saveSession(session);
}

// ---------- Main loop ----------
async function runTurn(session: CliSession, messages: any[]): Promise<boolean> {
  const model = session.model || MODEL;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Auto-compact if session too long
    await compactSession(session, messages);

    process.stderr.write(`\n--- turn ${turn + 1} [${model}] ---\n`);
    let response: StreamResult;
    try {
      response = await callGateway(messages, true, model);
    } catch (e: any) {
      console.error(`gateway error: ${e.message}`);
      return false;
    }

    const content: any[] = response.content;

    // Collect tool_use blocks (text already printed during stream)
    const toolUses = content.filter((b: any) => b.type === "tool_use");
    if (toolUses.length === 0) {
      // No tools called - print final text to stdout and exit turn
      const text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      console.log(text);
      return true;
    }

    // Add assistant message
    messages.push({ role: "assistant", content });

    // Execute tools
    for (const tu of toolUses) {
      const tool = toolMap.get(tu.name);
      let result: string;
      if (!tool) {
        result = `[error] unknown tool: ${tu.name}`;
      } else {
        process.stderr.write(`[run] ${tu.name} ${JSON.stringify(tu.input).slice(0, 200)}\n`);
        try {
          result = await tool.run(tu.input);
        } catch (e: any) {
          result = `[error] ${e.message}`;
        }
      }
      process.stderr.write(`[result] ${result.slice(0, 300)}\n`);
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: tu.id, content: result }],
      });
    }
  }
  console.error(`reached max turns (${MAX_TURNS})`);
  return false;
}

async function main() {
  const args = process.argv.slice(2);

  // --list: show all saved sessions
  if (args[0] === "--list" || args[0] === "-l") {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log("no saved sessions");
      process.exit(0);
    }
    console.log("saved sessions (newest first):");
    for (const s of sessions) {
      const age = s.updated ? new Date(s.updated).toLocaleString() : "?";
      const msgCount = s.messages?.length ?? 0;
      const preview = s.prompt?.slice(0, 60) ?? "(no prompt)";
      console.log(`  ${s.id}  ${age}  ${msgCount} msgs  [${s.cwd}]  "${preview}"`);
    }
    process.exit(0);
  }

  // --models: list available models
  if (args[0] === "--models") {
    console.log("available models:");
    console.log("  web-zai     chat.z.ai (GLM) - default");
    console.log("  web-chatgpt chatgpt.com");
    console.log("  web-kimi    kimi.ai (login required)");
    process.exit(0);
  }

  // Parse --model flag (can appear anywhere before prompt)
  let model = MODEL;
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    model = args[modelIdx + 1];
    args.splice(modelIdx, 2);
  }
  const mIdx = args.indexOf("-m");
  if (mIdx !== -1 && args[mIdx + 1]) {
    model = args[mIdx + 1];
    args.splice(mIdx, 2);
  }

  // --resume <id> [optional follow-up prompt]
  let session: CliSession;
  let initialPrompt: string;

  if (args[0] === "--resume" || args[0] === "-r") {
    const id = args[1];
    if (!id) {
      console.error("usage: tablm-cli --resume <session-id> [follow-up prompt]");
      process.exit(1);
    }
    const loaded = loadSession(id);
    if (!loaded) {
      console.error(`session not found: ${id}`);
      console.error("run: tablm-cli --list");
      process.exit(1);
    }
    session = loaded;
    initialPrompt = args.slice(2).join(" ") || "continue";
    process.stderr.write(`[resume] session ${id} (${session.messages.length} messages, cwd: ${session.cwd})\n`);
  } else {
    initialPrompt = args.join(" ");
    // No prompt given: start interactive mode - the REPL below collects the first task.
    const now = new Date().toISOString();
    session = {
      id: genSessionId(),
      created: now,
      updated: now,
      cwd: process.cwd(),
      model,
      prompt: initialPrompt,
      messages: [],
    };
  }

  const systemPrompt = `You are an autonomous coding agent. You have tools: Bash, Read, Write, Edit, Grep, Glob, WebSearch, WebFetch, BrowserNavigate, BrowserSnapshot, BrowserClick, BrowserFill, BrowserScreenshot, BrowserEval.

CRITICAL RULES:
1. DO NOT describe what you will do. DO NOT explain your plan. Just call the tool directly.
2. No preamble, no "I will now...", no "Let me...". Call the tool IMMEDIATELY.
3. If a task needs multiple steps, call tools for ALL steps in ONE response (multiple tool_use blocks).
4. Only output text when you have the FINAL answer (after all tools executed).
5. Work in ${session.cwd}.
6. When the task is complete, output only "DONE" + brief summary.
7. Use WebSearch for looking up info. Use WebFetch to read a URL. Use Browser* tools to interact with web pages (click, fill forms, navigate, screenshot, eval JS).
8. Browser workflow: BrowserNavigate to open page -> BrowserSnapshot to see structure -> BrowserClick/BrowserFill to interact -> BrowserScreenshot to verify.
9. To write files or pass any large string (>300 chars), use the payload form: set the field to "@payload:KEY" in the JSON, then output the raw content between "@@TABLM t1 KEY <<'EOF'" and "@@TABLM_END t1" lines right after the JSON. Never JSON-escape newlines or quotes - the payload is raw verbatim text.`;

  const messages = session.messages;

  // Run initial prompt (if one was passed on the command line)
  if (initialPrompt) {
    messages.push({ role: "user", content: initialPrompt });
    await runTurn(session, messages);
    saveSession(session);
  }

  // Interactive REPL: keep same session, accept follow-up prompts
  process.stderr.write(`\n=== session ${session.id} (cwd: ${session.cwd}) - type a task or follow-up, Ctrl-D to exit ===\n`);
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  while (true) {
    let line: string;
    try {
      line = await rl.question("> ");
    } catch {
      break;
    }
    if (line === null) break; // Ctrl-D
    line = line.trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") break;
    if (!session.prompt) session.prompt = line; // first input becomes the session title
    messages.push({ role: "user", content: line });
    await runTurn(session, messages);
    saveSession(session);
  }
  rl.close();
  saveSession(session);
  await closeScratchPage();
  process.stderr.write(`[session ${session.id} saved]\n`);
}

main().catch(async (e) => {
  console.error(e);
  await closeScratchPage();
  process.exit(1);
});
