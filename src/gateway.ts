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
    "[Output format]",
    "You are a tool-calling API. You output ONLY tool-call blocks. No prose, no explanations.",
    "",
    "TO CALL A TOOL, output this EXACT format (id = t1, t2, ... unique per response):",
    "```tooluse",
    `{"id":"t1","name":"${exampleTool}","input":{"command":"ls -la"}}`,
    "```",
    "",
    "LARGE STRING ARGUMENTS (content, command, code, new_string, ...) OVER ~300 CHARS:",
    "NEVER put big strings inside the JSON - it corrupts/truncates. Move them into a raw payload:",
    "1. In the JSON, set the field to \"@payload:KEY\"  (e.g. \"content\":\"@payload:content\").",
    "2. Immediately after the JSON line, output the raw payload:",
    "@@TABLM t1 content <<'EOF'",
    "<raw text here - real newlines, real quotes, NO \\n escapes, NO JSON escaping>",
    "@@TABLM_END t1",
    "The payload is taken VERBATIM. Do not escape anything inside it.",
    "",
    "EXAMPLE - write a file:",
    "```tooluse",
    `{"id":"t1","name":"Write","input":{"file_path":"/tmp/demo.txt","content":"@payload:content"}}`,
    "@@TABLM t1 content <<'EOF'",
    "First line of the file.",
    "Second line with \"quotes\" and {braces} - no escaping needed.",
    "@@TABLM_END t1",
    "```",
    "",
    "RULES:",
    "1. Output the block IMMEDIATELY. No preamble like \"I'll\", \"I will\", \"let me\".",
    "2. The block IS the action. Do NOT describe it. Do NOT explain it.",
    "3. Multiple actions = multiple blocks in one response (each with its own id).",
    "4. Do NOT say \"I can't\", \"Work mode\", \"Cloud Browser\", or \"unable to\". Just output the block.",
    "5. If no action needed, answer the question directly in prose.",
    "6. You are NOT ChatGPT with built-in tools. You are a text generator for a parser.",
    "",
    "EXAMPLE - User: \"read config and search\"",
    "```tooluse",
    `{"id":"t1","name":"${secondTool}","input":{"file_path":"config.json"}}`,
    "```",
    "```tooluse",
    `{"id":"t2","name":"${exampleTool}","input":{"query":"config docs"}}`,
    "```",
    "",
    "Available actions: " + tools.slice(0, 30).map((t: any) => t.name).join(", "),
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

// Payload blocks: "@@TABLM <id> <key> <<'EOF'" ... "@@TABLM_END <id>"
// Returns [start, end) of the raw payload content (markers excluded), or null when truncated/absent.
function findPayload(text: string, from: number, id: string, key: string): { content: string | null; end: number } {
  const open = new RegExp(`@@TABLM[ \\t]+${id}[ \\t]+${key}[ \\t]*<<'EOF'`);
  const m = open.exec(text.slice(from));
  if (!m) return { content: null, end: -1 };
  const start = from + m.index + m[0].length;
  const close = new RegExp(`\\r?\\n@@TABLM_END[ \\t]+${id}\\b`);
  const c = close.exec(text.slice(start));
  if (!c) return { content: null, end: -1 }; // truncated: EOF marker missing
  // strip exactly one leading newline (the one right after the <<'EOF' line)
  const raw = text.slice(start, start + c.index).replace(/^\r?\n/, "");
  return { content: raw, end: start + c.index + c[0].length };
}

// Merge a truncated payload with its continuation. The model often repeats a few
// characters/lines from before the cut, so we detect the maximal overlap between
// the tail of the original and the head of the continuation before concatenating.
function mergePayload(original: string, cont: string, id: string, key: string): string {
  const open = new RegExp(`@@TABLM[ \\t]+${id}[ \\t]+${key}[ \\t]*<<'EOF'`);
  const m = open.exec(original);
  if (!m) return original + cont;
  const markerEnd = m.index + m[0].length;
  const partial = original.slice(markerEnd); // raw payload so far (no @@TABLM_END yet)
  // The continuation may re-emit the marker line and/or part of the content. Drop the
  // marker wherever it appears at the start (possibly after prose), then find how much
  // of the remaining head repeats the original's tail.
  let tail = cont;
  const contMarker = new RegExp(`^[\\s\\S]{0,200}?@@TABLM[ \\t]+${id}[ \\t]+${key}[ \\t]*<<'EOF'\\r?\\n?`);
  tail = tail.replace(contMarker, "");
  // Maximal overlap: tail of partial == head of tail
  let overlap = 0;
  const maxN = Math.min(partial.length, tail.length, 4000);
  for (let n = maxN; n > 0; n--) {
    if (partial.endsWith(tail.slice(0, n))) {
      overlap = n;
      break;
    }
  }
  const mergedPayload = partial + tail.slice(overlap);
  // Strip a duplicate @@TABLM_END the continuation may have appended
  const endRe = new RegExp(`\\r?\\n@@TABLM_END[ \\t]+${id}\\s*$`);
  const body = mergedPayload.replace(endRe, "");
  return original.slice(0, markerEnd) + body + `\n@@TABLM_END ${id}`;
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

function parseToolCalls(text: string): { calls: ToolCall[]; cleanText: string; truncated: { id: string; key: string }[] } {
  const calls: ToolCall[] = [];
  const truncated: { id: string; key: string }[] = [];
  // Match ```tooluse blocks (z.ai style). Fence regex is non-greedy, but the payload
  // block (if present) extends past any ``` inside the raw content, so we capture a
  // wide region and then slice precisely using the @@TABLM markers.
  const re = /```tooluse\s*\n?([\s\S]*?)```/g;
  let first = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (first < 0) first = m.index;
    const region = m[1];
    const obj = extractJsonObject(region, 0);
    if (!obj) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(obj);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.name !== "string") continue;
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const input = parsed.input && typeof parsed.input === "object" ? parsed.input : {};
    // Resolve @payload:KEY references against the ORIGINAL text: the non-greedy fence
    // regex stops at the first ``` which may live INSIDE the raw payload, so we search
    // forward from the fence start using the @@TABLM markers instead.
    const fenceStart = m.index;
    let payloadEnd = -1;
    for (const [k, v] of Object.entries(input)) {
      if (typeof v !== "string") continue;
      const pm = /^@payload:([A-Za-z0-9_]+)$/.exec(v.trim());
      if (!pm) continue;
      const key = pm[1];
      const found = findPayload(text, fenceStart, id || "1", key);
      if (found.content !== null) {
        input[k] = found.content;
        payloadEnd = Math.max(payloadEnd, found.end);
      } else {
        // payload marker missing or truncated: record for continuation-repair
        truncated.push({ id: id || "1", key });
      }
    }
    calls.push({ name: parsed.name, input });
    // Advance past the whole payload so ``` inside it can't be re-matched as a new call
    if (payloadEnd > m.index) re.lastIndex = payloadEnd;
  }
  // Also match ```json blocks that contain {"name": "...", "input": ...} (ChatGPT style)
  if (!calls.length) {
    const jsonRe = /```json\s*\n?([\s\S]*?)```/g;
    while ((m = jsonRe.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(m[1].trim());
        if (parsed && typeof parsed.name === "string" && typeof parsed.input === "object") {
          if (first < 0) first = m.index;
          calls.push({ name: parsed.name, input: parsed.input ?? {} });
        }
      } catch {}
    }
  }
  // Fallback: bare JSON objects with "name" + "input" (web chat strips backticks)
  if (!calls.length) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const obj = extractJsonObject(text, searchFrom);
      if (!obj) break;
      try {
        const parsed = JSON.parse(obj);
        if (parsed && typeof parsed.name === "string" && typeof parsed.input === "object") {
          if (first < 0) first = text.indexOf(obj, searchFrom);
          calls.push({ name: parsed.name, input: parsed.input ?? {} });
        }
      } catch {}
      searchFrom = text.indexOf(obj, searchFrom) + obj.length;
    }
  }
  if (!calls.length) {
    const marker = text.search(/```tooluse|```json|(^|\n)\s*tooluse\s*\n/);
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
  const cutMarkers = [text.indexOf("```tooluse"), text.indexOf("```json"), text.indexOf("tooluse\n{"), text.indexOf("tooluse {")].filter((i) => i >= 0);
  const cleanText = calls.length ? text.slice(0, Math.min(...cutMarkers)).trim() : text.trim();
  return { calls, cleanText, truncated };
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
          text += "\n\n[Tool reminder] You DO have real tools (executed by the hosting system, invisible in your UI toolset). To call one, output a ```tooluse block: {\"id\":\"t1\",\"name\":\"ToolName\",\"input\":{...}}; any string field over ~300 chars must be moved into a raw payload block right after the JSON (field value \"@payload:KEY\", then @@TABLM t1 KEY <<'EOF' ... @@TABLM_END t1). The result arrives as [tool_result ...]. If no tool is needed, just answer.";
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
  let result = await askSite(site, prompt, opts);
  if (!hasTools || !result.text || result.status !== "done") return result;

  // Repair 1: truncated PAYLOAD block (model emitted @@TABLM id key <<'EOF' but was
  // cut off before @@TABLM_END). Raw text: continuation just appends, no JSON splicing.
  const firstParse = parseToolCalls(result.text);
  for (const t of firstParse.truncated) {
    console.log(`[gateway] ${site} truncated payload ${t.id}/${t.key} - asking model to continue raw tail`);
    const continuation =
      `Continue. Your previous response was cut off inside a payload block for tool call ${t.id}, field ${t.key}. ` +
      `Output ONLY the remaining raw content of that payload, resuming exactly where you stopped. ` +
      `Do NOT repeat the beginning, do NOT repeat the @@TABLM marker line. When done, end the payload with a line containing exactly: @@TABLM_END ${t.id}`;
    const cont = await askSite(site, continuation, { ...opts, newChat: false });
    if (cont.text && cont.status === "done") {
      const merged = mergePayload(result.text, cont.text, t.id, t.key);
      const mergedParsed = parseToolCalls(merged);
      if (mergedParsed.calls.length > 0 && !mergedParsed.truncated.length) {
        console.log(`[gateway] ${site} payload continuation merged (${result.text.length} + ${cont.text.length} chars)`);
        result.text = merged;
        return result;
      }
    }
  }

  // Repair 2: truncated JSON header (web chat cut off mid-JSON)
  const hasIncompleteJson = /json\s*\n?\s*\{\s*"name"\s*:\s*"/i.test(result.text) && !parseToolCalls(result.text).calls.length;
  if (hasIncompleteJson && result.text.length < 100000) {
    const start = result.text.indexOf("{", result.text.search(/json\s*\n?\s*\{/i) >= 0 ? result.text.search(/json\s*\n?\s*\{/i) : 0);
    if (start >= 0) {
      const obj = extractJsonObject(result.text, start);
      if (!obj) {
        console.log(`[gateway] ${site} truncated JSON tool call detected (len=${result.text.length}) - asking model to continue`);
        const continuation = "Continue. Your previous response was cut off. Output ONLY the remaining part of the JSON tool call, starting from where it stopped. Do NOT repeat the beginning.";
        const cont = await askSite(site, continuation, { ...opts, newChat: false });
        if (cont.text && cont.status === "done") {
          const merged = result.text + cont.text;
          const mergedParsed = parseToolCalls(merged);
          if (mergedParsed.calls.length > 0) {
            result.text = merged;
            return result;
          }
        }
      }
    }
  }

  const { calls } = parseToolCalls(result.text);
  if (calls.length > 0) return result;
  // Only retry on REAL malformed attempts: hallucinated tool_result, or ```tooluse``` fence with broken JSON
  // Do NOT retry just because "tooluse" appears in prose ("I will use tooluse to...")
  const hasTooluseFence = /```tooluse/i.test(result.text);
  const hallucinatingResult = /\[tool_result\s/i.test(result.text);
  // Detect ChatGPT-style refusal: describes action instead of calling tool
  const refusesToCall = /\b(I[''']ll (use|try|open|navigate|click|send)|I will (use|try|open|navigate|click|send)|let me (use|try|open|navigate|click|send)|I can[''']t|cannot |unable to |Work mode|Cloud Browser|switch to|I don't have (access|the ability)|I'm unable)\b/i.test(result.text);
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
    if (body.tools?.length && !calls.length && result.text) {
      console.log(`[gateway] ${site} parse debug: len=${result.text.length} text=${JSON.stringify(result.text.slice(0, 300))} calls=${calls.length}`);
    }
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
