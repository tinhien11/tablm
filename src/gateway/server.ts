// Anthropic-compatible gateway HTTP server.
//
// Thin by design: it translates /v1/messages into a web-chat turn and streams
// the result back as SSE. All tool-protocol logic lives in src/protocol and
// all conversation state in conversation.ts. This file owns only the wire.

import http from "node:http";
import { askSite } from "../transport/driver.js";
import { SITES } from "../transport/driver.js";
import { startBridge, submitJob, bridgeConnected } from "../transport/bridge.js";
import { parseToolCalls } from "../protocol/parse.js";
import {
  classify,
  repairTruncatedPayload,
  repairTruncatedJson,
  repairPromptFor,
} from "../protocol/repair.js";
import {
  buildPrompt,
  buildFullPrompt,
  siteFromModel,
  estimateTokens,
} from "./conversation.js";

const MODEL_IDS = Object.keys(SITES).map((id) => `web-${id}`);
const PORT = Number(process.env.TABLM_GATEWAY_PORT || 8788);
const HOST = process.env.TABLM_GATEWAY_HOST || "127.0.0.1";
const MAX_REPAIR_ROUNDS = Number(process.env.TABLM_MAX_REPAIRS || 3);

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Run one web-chat turn, then apply deterministic repairs until the outcome is
 * usable or the repair budget is exhausted. Each failure class has exactly one
 * strategy, so this loop provably terminates.
 */
async function askWithRepair(
  site: string,
  prompt: string,
  opts: { newChat: boolean; session?: string; timeoutS: number },
  hasTools: boolean
): Promise<{ text: string; status: string; thinking?: string }> {
  let result = await askSite(site, prompt, opts);
  if (!hasTools || !result.text || result.status !== "done") return result;

  for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
    const parsed = parseToolCalls(result.text);
    const outcome = classify(parsed, result.text);
    if (outcome.kind === "ok") return result;

    const ask = (p: string) =>
      askSite(site, p, { ...opts, newChat: false }).then((r) => r.text ?? "");

    if (outcome.kind === "truncated_payload") {
      console.log(`[gateway] ${site} truncated payload - asking for raw continuation`);
      const merged = await repairTruncatedPayload(result.text, outcome.truncated, ask);
      if (merged) {
        console.log(`[gateway] ${site} payload continuation merged`);
        result = { ...result, text: merged };
        continue;
      }
      break;
    }

    if (outcome.kind === "truncated_json") {
      console.log(`[gateway] ${site} truncated JSON header - asking for continuation`);
      const merged = await repairTruncatedJson(result.text, ask);
      if (merged) {
        console.log(`[gateway] ${site} JSON continuation merged`);
        result = { ...result, text: merged };
        continue;
      }
      break;
    }

    // narrated / refused: correct once and let the model redo the turn
    console.log(`[gateway] ${site} outcome=${outcome.kind} - correcting (round ${round + 1})`);
    const correction = repairPromptFor(outcome.kind, outcome.blocked, prompt);
    const retry = await askSite(site, correction, { ...opts, newChat: false });
    if (retry.text && retry.status === "done") {
      const reparsed = parseToolCalls(retry.text);
      if (reparsed.calls.some((c) => c.unresolved.length === 0)) return retry;
      result = retry; // improved but still imperfect; keep repairing
      continue;
    }
    break;
  }

  return result;
}

async function handleMessages(body: any, res: http.ServerResponse): Promise<void> {
  const { site, session } = siteFromModel(body.model);
  const sessionKey = `${site}:${session ?? "default"}`;
  const built = buildPrompt(body, sessionKey);
  const { prompt, mode } = built;
  // Start a fresh web chat ONLY when none exists or the current one crossed
  // its rollover budget. Divergence (CLI compaction, resume, oversized delta)
  // re-syncs the SAME chat - conversations are kept alive as long as possible.
  const newChat = mode === "full" && (!built.hadConversation || built.rolloverDue);
  console.log(
    `[gateway] ${site} prompt=${prompt.length} chars (${mode})${newChat ? " NEW-CHAT" : built.resync ? " re-sync" : ""}${built.rolloverDue ? " [rollover]" : ""}`
  );
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (body.stream === true) {
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
    const started = Date.now();
    try {
      result = await askWithRepair(
        site,
        prompt,
        { newChat, session, timeoutS: 100 },
        hasTools
      );
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

    const parsed = parseToolCalls(result.text || "");
    const usable = parsed.calls.filter((c) => c.unresolved.length === 0);
    const blocked = parsed.calls.filter((c) => c.unresolved.length > 0);
    if (hasTools && !usable.length && result.text) {
      console.log(
        `[gateway] ${site} parse debug: len=${result.text.length} text=${JSON.stringify(result.text.slice(0, 300))} calls=${parsed.calls.length} blocked=${blocked.length}`
      );
    }
    // Fail-closed surface: blocked calls are reported to the client as text, never as tool_use.
    let cleanText = parsed.cleanText;
    if (blocked.length && !cleanText) {
      cleanText = `[tablm] ${blocked.length} tool call(s) had unresolved payload references and were not executed. Re-emit them with their @@TABLM payload blocks.`;
    }

    let index = 0;
    if (result.thinking) {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      for (let i = 0; i < result.thinking.length; i += 800) {
        sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: result.thinking.slice(i, i + 800) } });
      }
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "tablm" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index });
      index++;
    }
    if (cleanText) {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (let i = 0; i < cleanText.length; i += 800) {
        sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: cleanText.slice(i, i + 800) } });
      }
      sse(res, "content_block_stop", { type: "content_block_stop", index });
      index++;
    }
    for (const call of usable) {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${Date.now()}_${index}`, name: call.name, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input ?? {}) } });
      sse(res, "content_block_stop", { type: "content_block_stop", index });
      index++;
    }
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: usable.length ? "tool_use" : result.status === "done" ? "end_turn" : "max_tokens", stop_sequence: null },
      usage: { output_tokens: estimateTokens(result.text || "") },
    });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
    console.log(`[gateway] ${site} ${result.status} ${Date.now() - started}ms ${result.text?.length ?? 0} chars${usable.length ? ` tool_calls:${usable.length}` : ""}${blocked.length ? ` blocked:${blocked.length}` : ""}`);
    return;
  }

  // non-streaming
  try {
    const result = await askWithRepair(site, prompt, { newChat, session, timeoutS: 100 }, hasTools);
    const parsed = parseToolCalls(result.text || "");
    const usable = parsed.calls.filter((c) => c.unresolved.length === 0);
    const content: any[] = [];
    if (result.thinking) content.push({ type: "thinking", thinking: result.thinking, signature: "tablm" });
    if (parsed.cleanText) content.push({ type: "text", text: parsed.cleanText });
    for (const c of usable) content.push({ type: "tool_use", id: `toolu_${Date.now()}_${content.length}`, name: c.name, input: c.input });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: body.model ?? "web-model",
        content,
        stop_reason: usable.length ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: estimateTokens(prompt), output_tokens: estimateTokens(parsed.cleanText) },
      })
    );
    console.log(`[gateway] ${site} ${result.status} ${parsed.cleanText.length} chars${usable.length ? ` tool_calls:${usable.length}` : ""}`);
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

export function createServer(): http.Server {
  return http.createServer((req, res) => {
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
        const job = {
          site: body.site,
          operation: body.operation,
          prompt: body.prompt,
          conversation: body.conversation,
          timeoutS: body.timeout_s,
        };
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
}

// Legacy default: start on import (install.sh runs `node dist/gateway.js`).
startBridge();
createServer().listen(PORT, HOST, () => {
  console.log(`tablm gateway listening on http://${HOST}:${PORT}`);
  console.log(`use with: ANTHROPIC_BASE_URL=http://${HOST}:${PORT} ANTHROPIC_AUTH_TOKEN=tablm claude --model web-zai`);
});
