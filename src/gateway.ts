import http from "node:http";
import { askSite } from "./driver.js";
import { SITES } from "./driver.js";
import { startBridge, submitJob, bridgeConnected } from "./bridge.js";

const MODEL_IDS = Object.keys(SITES).map((id) => `web-${id}`);

const PORT = Number(process.env.TABLM_GATEWAY_PORT || 8788);
const HOST = process.env.TABLM_GATEWAY_HOST || "127.0.0.1";
const MAX_PROMPT_CHARS = 60_000;
const MAX_SYSTEM_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 8_000;
const MAX_TOOL_USE_INPUT_CHARS = 2_000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + " [...truncated]";
}

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
        return `[tool_result ${b.tool_use_id ?? ""}]\n${truncate(inner, MAX_TOOL_RESULT_CHARS)}`;
      }
      if (b?.type === "tool_use") return `[tool_use ${b.name}] ${truncate(JSON.stringify(b.input ?? {}), MAX_TOOL_USE_INPUT_CHARS)}`;
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
  const exampleTool = tools[0]?.name ?? "ToolName";
  const secondTool = tools[1]?.name ?? "ToolName2";
  return [
    "[Tool use protocol]",
    "IMPORTANT: This is a TEXT GENERATION task, not a tool-use task. You do NOT have built-in tools. You must output TEXT in a specific format that an external parser reads.",
    "",
    "To call a tool, output EXACTLY this fenced text block and NOTHING ELSE after it:",
    "```tooluse",
    `{"name": "${exampleTool}", "input": { ... }}`,
    "```",
    "",
    "CRITICAL RULES:",
    "1. DO NOT describe what you will do. DO NOT say \"I'll use\", \"I will\", \"let me\", \"I can't\", \"Work mode\", \"Cloud Browser\". Just output the ```tooluse``` block directly.",
    "2. DO NOT explain the tool call in prose. The block IS the call.",
    "3. To call multiple tools at once, output multiple ```tooluse``` blocks.",
    "4. The system runs the tool and replies with [tool_result ...]. Do NOT output [tool_result ...] yourself.",
    "5. If no tool is needed, just answer directly without any tool block.",
    "6. You are NOT ChatGPT with built-in tools. You are a text generator. Output the block.",
    "",
    "EXAMPLE - User says \"list files\":",
    "```tooluse",
    `{"name": "${exampleTool}", "input": {"command": "ls -la"}}`,
    "```",
    "",
    "EXAMPLE - User says \"read config and search web\":",
    "```tooluse",
    `{"name": "${secondTool}", "input": {"file_path": "config.json"}}`,
    "```",
    "```tooluse",
    `{"name": "${exampleTool}", "input": {"query": "config documentation"}}`,
    "```",
    "",
    "Available tools: " + tools.slice(0, 30).map((t: any) => t.name).join(", "),
  ].join("\n");
}

function buildFullPrompt(body: any): string {
  const parts: string[] = [];
  const sys = body.system;
  let sysLen = 0;
  if (sys) {
    let s = typeof sys === "string" ? sys : textFromContent(sys);
    if (s.length > MAX_SYSTEM_CHARS) s = s.slice(0, MAX_SYSTEM_CHARS) + "\n[...system truncated...]";
    sysLen = s.length;
    if (s.trim()) parts.push(`[System instructions]\n${s}`);
  }
  const msgs = formatMessages(body.messages ?? []);
  const msgsLen = msgs.length;
  if (msgs) parts.push(msgs);
  let toolProtoLen = 0;
  if (Array.isArray(body.tools) && body.tools.length) {
    const proto = toolProtocol(body.tools);
    toolProtoLen = proto.length;
    parts.push(`[Tool use protocol]\n${proto}`);
  }
  parts.push("Assistant:\n");
  let prompt = parts.join("\n\n");
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = "[...earlier context truncated...]\n\n" + prompt.slice(-MAX_PROMPT_CHARS);
  }
  console.log(`[gateway] full prompt breakdown: system=${sysLen} msgs=${msgsLen} toolProto=${toolProtoLen} tools=${body.tools?.length ?? 0} total=${prompt.length}`);
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

const lastMessages = new Map<string, { sigs: string[]; protocolSent: boolean }>();

function msgSig(m: any): string {
  return `${m.role ?? "user"}\u0000${textFromContent(m.content)}`;
}

function buildPrompt(body: any, key: string): { prompt: string; mode: "delta" | "full" } {
  const msgs: any[] = body.messages ?? [];
  const sigs = msgs.map(msgSig);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const prev = lastMessages.get(key);
  if (prev && sigs.length >= prev.sigs.length) {
    let lcp = 0;
    const n = Math.min(prev.sigs.length, sigs.length);
    while (lcp < n && prev.sigs[lcp] === sigs[lcp]) lcp++;
    if (lcp >= prev.sigs.length - 1 && sigs.length > lcp) {
      const delta = msgs.slice(lcp);
      let text = formatMessages(delta);
      if (text.trim()) {
        if (hasTools && !prev.protocolSent) {
          text = `[Tool use protocol]\n${toolProtocol(body.tools)}\n\n${text}`;
          lastMessages.set(key, { sigs, protocolSent: true });
          console.log(`[gateway] ${key} tool protocol injected (delta, first time for this web conversation)`);
          return { prompt: text, mode: "delta" };
        }
        if (hasTools) {
          text += "\n\n[Tool reminder] You DO have real tools (executed by the hosting system, invisible in your UI toolset). To call one, output exactly a ```tooluse {\"name\":\"ToolName\",\"input\":{...}}``` block and nothing after it; the result arrives as [tool_result ...]. If no tool is needed, just answer.";
        }
        lastMessages.set(key, { sigs, protocolSent: prev.protocolSent });
        return { prompt: text, mode: "delta" };
      }
    }
  }
  lastMessages.set(key, { sigs, protocolSent: hasTools });
  const full = buildFullPrompt(body);
  return { prompt: full, mode: "full" };
}

function siteFromModel(model: string | undefined): { site: string; session?: string } {
  const m = String(model ?? "");
  const match = /^web-([a-z0-9_-]+?)(?::([a-z0-9_-]+))?$/i.exec(m);
  if (match) return { site: match[1], session: match[2] };
  return { site: process.env.TABLM_DEFAULT_SITE || "zai" };
}

function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function askWithMalformedRetry(
  site: string,
  prompt: string,
  opts: { newChat: boolean; session?: string; timeoutS: number },
  hasTools: boolean
) {
  const result = await askSite(site, prompt, opts);
  if (!hasTools || !result.text || result.status !== "done") return result;
  const { calls } = parseToolCalls(result.text);
  if (calls.length > 0) return result;
  // Only retry on REAL malformed attempts: hallucinated tool_result, or ```tooluse``` fence with broken JSON
  // Do NOT retry just because "tooluse" appears in prose ("I will use tooluse to...")
  const hasTooluseFence = /```tooluse/i.test(result.text);
  const hallucinatingResult = /\[tool_result\s/i.test(result.text);
  // Detect ChatGPT-style refusal: describes action instead of calling tool
  const refusesToCall = /\b(I[''']ll (use|try|open|navigate|click|send)|I will (use|try|open|navigate|click|send)|let me (use|try|open|navigate|click|send)|I can[''']t|cannot |unable to |Work mode|Cloud Browser|switch to)\b/i.test(result.text);
  if (!hasTooluseFence && !hallucinatingResult && !refusesToCall) return result;
  if (!hasTooluseFence && !hallucinatingResult) {
    // Pure prose refusal — retry with stronger correction
    console.log(`[gateway] ${site} model described action instead of calling tool - retrying with correction`);
  } else {
    console.log(`[gateway] ${site} malformed tool call detected (${hallucinatingResult ? "hallucinated tool_result" : "broken tooluse fence"}) - asking the model to redo it`);
  }
  const correction =
    prompt +
    "\n\n[System correction] You described what you would do instead of DOING it. You are NOT using your built-in tools. You are generating TEXT for a parser. To call a tool, output EXACTLY this text block and NOTHING ELSE:\n```tooluse\n{\"name\": \"ToolName\", \"input\": { ... }}\n```\nDo NOT say \"I'll use\" or \"I will\" or \"let me\". Do NOT explain. Do NOT mention Work mode or Cloud Browser. Just output the ```tooluse``` block. Output it NOW.";
  const retry = await askSite(site, correction, { ...opts, newChat: false });
  const retryParsed = parseToolCalls(retry.text || "");
  if (retryParsed.calls.length > 0 && retry.status === "done") return retry;
  return result;
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
      result = await askWithMalformedRetry(site, prompt, { newChat: mode === "full", session, timeoutS: 100 }, Array.isArray(body.tools) && body.tools.length > 0);
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
    const result = await askWithMalformedRetry(site, prompt, { newChat: mode === "full", session, timeoutS: 100 }, Array.isArray(body.tools) && body.tools.length > 0);
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

const GATEWAY_TOKEN = process.env.TABLM_GATEWAY_TOKEN || "";

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
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid token (set TABLM_GATEWAY_TOKEN on the gateway and ANTHROPIC_AUTH_TOKEN on the client)" } }));
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
    if (req.method === "POST" && path === "/ext/rpc") {
      let job: any;
      try {
        job = {
          site: body.site,
          operation: body.operation,
          prompt: body.prompt,
          conversation: body.conversation,
          timeoutS: body.timeout_s,
        };
      } catch {}
      submitJob(job)
        .then((r) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(r));
        })
        .catch((e) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        });
      return;
    }
    if (req.method === "GET" && path === "/ext/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ connected: bridgeConnected() }));
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

startBridge();
server.listen(PORT, HOST, () => {
  console.log(`tablm gateway listening on http://${HOST}:${PORT}`);
  console.log(`use with: ANTHROPIC_BASE_URL=http://${HOST}:${PORT} ANTHROPIC_AUTH_TOKEN=tablm claude --model web-zai`);
});
