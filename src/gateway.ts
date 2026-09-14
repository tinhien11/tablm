import http from "node:http";
import { askSite } from "./driver.js";
import { SITES } from "./driver.js";

const MODEL_IDS = Object.keys(SITES).map((id) => `web-${id}`);

const PORT = Number(process.env.WEB2MODEL_GATEWAY_PORT || 8788);
const HOST = process.env.WEB2MODEL_GATEWAY_HOST || "127.0.0.1";
const MAX_PROMPT_CHARS = 60_000;
const MAX_SYSTEM_CHARS = 8_000;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => {
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "tool_result") {
        const inner =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c: any) => c.text ?? "").join("\n")
              : JSON.stringify(b.content ?? "");
        return `[tool_result ${b.tool_use_id ?? ""}]\n${inner}`;
      }
      if (b?.type === "tool_use") return `[tool_use ${b.name}] ${JSON.stringify(b.input ?? {})}`;
      if (b?.type === "image") return "[image attached]";
      if (b?.type === "thinking") return "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatMessages(msgs: any[]): string {
  return (msgs ?? [])
    .map((m: any) => {
      const role = m.role === "assistant" ? "Assistant" : "User";
      const text = textFromContent(m.content);
      return text.trim() ? `${role}:\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function toolProtocol(tools: any[]): string {
  return [
    "[Tool use protocol]",
    "You can use these tools to interact with the user's local machine:",
    ...tools.slice(0, 30).map((t: any) => `- ${t.name}: ${String(t.description ?? "").slice(0, 120)}`),
    "To call a tool, output EXACTLY this block and nothing after it:",
    "```tooluse",
    '{"name": "ToolName", "input": { ... }}',
    "```",
    "The tool result will then be provided as [tool_result ...]. Use tools whenever they help; for plain conversation just answer directly without any tool block.",
  ].join("\n");
}

function buildFullPrompt(body: any): string {
  const parts: string[] = [];
  const sys = body.system;
  if (sys) {
    let s = typeof sys === "string" ? sys : textFromContent(sys);
    if (s.length > MAX_SYSTEM_CHARS) s = s.slice(0, MAX_SYSTEM_CHARS) + "\n[...system truncated...]";
    if (s.trim()) parts.push(`[System instructions]\n${s}`);
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    parts.push(`[Tool use protocol]\n${toolProtocol(body.tools)}`);
  }
  const msgs = formatMessages(body.messages ?? []);
  if (msgs) parts.push(msgs);
  parts.push("Assistant:\n");
  let prompt = parts.join("\n\n");
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = "[...earlier context truncated...]\n\n" + prompt.slice(-MAX_PROMPT_CHARS);
  }
  return prompt;
}

interface ToolCall {
  name: string;
  input: any;
}

let toolCounter = 0;

function tooluId(): string {
  return `toolu_${Date.now()}_${++toolCounter}`;
}

function extractJsonObject(text: string, from: number): string | null {
  const start = text.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseToolCalls(text: string): { calls: ToolCall[]; cleanText: string } {
  const calls: ToolCall[] = [];
  const re = /```tooluse\s*\n?([\s\S]*?)```/g;
  let first = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (first < 0) first = m.index;
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && typeof parsed.name === "string") {
        calls.push({ name: parsed.name, input: parsed.input ?? {} });
      }
    } catch {}
  }
  if (!calls.length) {
    const marker = text.search(/```tooluse|(^|\n)\s*tooluse\s*\n/);
    if (marker >= 0) {
      const obj = extractJsonObject(text, marker);
      if (obj) {
        try {
          const parsed = JSON.parse(obj);
          if (parsed && typeof parsed.name === "string") {
            calls.push({ name: parsed.name, input: parsed.input ?? {} });
          }
        } catch {}
      }
    }
  }
  const cutMarkers = [text.indexOf("```tooluse"), text.indexOf("tooluse\n{"), text.indexOf("tooluse {")].filter((i) => i >= 0);
  const cleanText = calls.length ? text.slice(0, Math.min(...cutMarkers)).trim() : text.trim();
  return { calls, cleanText };
}

const lastMessages = new Map<string, string[]>();

function msgSig(m: any): string {
  return `${m.role ?? "user"}\u0000${textFromContent(m.content)}`;
}

function buildPrompt(body: any, key: string): { prompt: string; mode: "delta" | "full" } {
  const msgs: any[] = body.messages ?? [];
  const sigs = msgs.map(msgSig);
  const prev = lastMessages.get(key);
  if (prev && sigs.length >= prev.length) {
    let lcp = 0;
    const n = Math.min(prev.length, sigs.length);
    while (lcp < n && prev[lcp] === sigs[lcp]) lcp++;
    if (lcp >= prev.length - 1 && sigs.length > lcp) {
      const delta = msgs.slice(lcp);
      const text = formatMessages(delta);
      if (text.trim()) {
        lastMessages.set(key, sigs);
        return { prompt: text, mode: "delta" };
      }
    }
  }
  lastMessages.set(key, sigs);
  const full = buildFullPrompt(body);
  return { prompt: full, mode: "full" };
}

function siteFromModel(model: string | undefined): { site: string; session?: string } {
  const m = String(model ?? "");
  const match = /^web-([a-z0-9_-]+?)(?::([a-z0-9_-]+))?$/i.exec(m);
  if (match) return { site: match[1], session: match[2] };
  return { site: process.env.WEB2MODEL_DEFAULT_SITE || "chatgpt" };
}

function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleMessages(body: any, res: http.ServerResponse): Promise<void> {
  const { site, session } = siteFromModel(body.model);
  const sessionKey = `${site}:${session ?? "default"}`;
  const { prompt, mode } = buildPrompt(body, sessionKey);
  console.log(`[gateway] ${site} prompt=${prompt.length} chars (${mode})`);
  const wantStream = body.stream === true;
  const started = Date.now();
  if (wantStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const messageId = `msg_${Date.now()}`;
    sse(res, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: body.model ?? "web-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: estimateTokens(prompt), output_tokens: 0 },
      },
    });
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {}
    }, 15000);
    let result;
    try {
      result = await askSite(site, prompt, { newChat: mode === "full", session, timeoutS: 100 });
    } catch (e) {
      clearInterval(ping);
      const msg = e instanceof Error ? e.message : String(e);
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `[tablm error] ${msg}` } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
      return;
    }
    clearInterval(ping);
    const { calls, cleanText } = parseToolCalls(result.text || "");
    let index = 0;
    if (result.thinking) {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      for (let i = 0; i < result.thinking.length; i += 800) {
        sse(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: result.thinking.slice(i, i + 800) },
        });
      }
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "tablm" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index });
      index++;
    }
    if (cleanText) {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (let i = 0; i < cleanText.length; i += 800) {
        sse(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: cleanText.slice(i, i + 800) },
        });
      }
      sse(res, "content_block_stop", { type: "content_block_stop", index });
      index++;
    }
    for (const call of calls) {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: tooluId(), name: call.name, input: {} } });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input ?? {}) },
      });
      sse(res, "content_block_stop", { type: "content_block_stop", index });
      index++;
    }
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: calls.length ? "tool_use" : result.status === "done" ? "end_turn" : "max_tokens", stop_sequence: null },
      usage: { output_tokens: estimateTokens(result.text || "") },
    });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
    console.log(`[gateway] ${site} ${result.status} ${Date.now() - started}ms ${result.text?.length ?? 0} chars${result.thinking ? " +thinking:" + result.thinking.length : ""}${calls.length ? ` tool_calls:${calls.length}` : ""}`);
    return;
  }
  try {
    const result = await askSite(site, prompt, { newChat: mode === "full", session, timeoutS: 100 });
    const { calls, cleanText } = parseToolCalls(result.text || "");
    const text = cleanText || (calls.length ? "" : result.error ? `[tablm ${result.status}] ${result.error}` : "");
    const content: any[] = [];
    if (result.thinking) {
      content.push({ type: "thinking", thinking: result.thinking, signature: "tablm" });
    }
    if (cleanText) content.push({ type: "text", text });
    for (const c of calls) {
      content.push({ type: "tool_use", id: tooluId(), name: c.name, input: c.input });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: body.model ?? "web-model",
        content,
        stop_reason: calls.length ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: estimateTokens(prompt), output_tokens: estimateTokens(text) },
      })
    );
    console.log(`[gateway] ${site} ${result.status} ${Date.now() - started}ms ${text.length} chars${result.thinking ? " +thinking:" + result.thinking.length : ""}${calls.length ? ` tool_calls:${calls.length}` : ""}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `tablm: ${msg}` } }));
  }
}

const GATEWAY_TOKEN = process.env.WEB2MODEL_GATEWAY_TOKEN || "";

function authorized(req: http.IncomingMessage): boolean {
  if (!GATEWAY_TOKEN) return true;
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey === GATEWAY_TOKEN) return true;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth === `Bearer ${GATEWAY_TOKEN}`) return true;
  return false;
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  let body: any = {};
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "invalid JSON body" } }));
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid token (set WEB2MODEL_GATEWAY_TOKEN on the gateway and ANTHROPIC_AUTH_TOKEN on the client)" } }));
      return;
    }
    if (req.method === "POST" && (path === "/v1/messages" || path === "/v1/messages/count_tokens")) {
      if (path.endsWith("/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: estimateTokens(JSON.stringify(body)) }));
        return;
      }
      try {
        await handleMessages(body, res);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `tablm: ${msg}` } }));
        } else {
          res.end();
        }
      }
      return;
    }
    if (req.method === "GET" && (path === "/" || path === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "tablm-gateway", sites: MODEL_IDS }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `unknown route ${req.method} ${path}` } }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`tablm gateway listening on http://${HOST}:${PORT}`);
  console.log(`use with: ANTHROPIC_BASE_URL=http://${HOST}:${PORT} ANTHROPIC_AUTH_TOKEN=tablm claude --model web-chatgpt`);
});
