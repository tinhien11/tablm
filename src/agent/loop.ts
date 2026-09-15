// The agent turn loop.
//
// STOP SEMANTICS (the bug being fixed): the old loop treated "no tool calls"
// as "task complete", so planning prose ("I have most of the picture now. Let
// me read the remaining core files") ended the task. Now a tool-free turn ends
// the task only when the model has ALREADY acted, or when it looks like a
// genuine direct answer. Otherwise we nudge once and then accept.
//
// FAIL-CLOSED: blocked calls (unresolved payloads) are never executed. They
// are reported to the model as a tool_result so it can re-emit them correctly.

import { appendEvent, type Session } from "./log.js";
import { groupRounds, planCompaction, totalChars } from "./rounds.js";
import { toolMap } from "./tools/registry.js";
import type { ToolContext } from "./tools/index.js";
import { parseToolCalls } from "../protocol/parse.js";

const GATEWAY = process.env.TABLM_GATEWAY_URL || "http://127.0.0.1:8788";
const AUTH_TOKEN = process.env.TABLM_AUTH_TOKEN || "tablm";
const MAX_TURNS = Number(process.env.TABLM_MAX_TURNS || 50);
const MAX_RESULT_CHARS = Number(process.env.TABLM_MAX_RESULT_CHARS || 8000);
/**
 * Hard enforcement of the parallel-call cap (contract v4 asks for <=3; this is
 * the bound that actually holds). Growth per turn is capped at
 * MAX_CALLS_PER_TURN x MAX_RESULT_CHARS, which keeps a single round inside the
 * compaction keep-budget even when the model ignores the prompt rule entirely.
 */
const MAX_CALLS_PER_TURN = Number(process.env.TABLM_MAX_CALLS_PER_TURN || 6);

/** PLANNING language: the model is narrating instead of acting. */
const PLANNING = [
  /\blet me (read|check|look|examine|see|understand|gather|start|begin)/i,
  /\bi have (most of|a good|the) (picture|context|understanding)/i,
  /\bbefore (i|making|we) (make|change|edit|write|commit|doing)/i,
  /\bi('ll| will) (read|check|look|examine|see|gather|start|begin)/i,
  // Vietnamese - the model works in the user's language, patterns must too
  /\bbắt đầu (phase|quy trình|giai đoạn)?/i,
  /\btôi sẽ\b/i,
  /\blên plan\b|\blập kế hoạch\b/i,
  /\bđọc (hết|toàn bộ|các file)\b/i,
  /\bxem xét (toàn bộ|kỹ)\b/i,
];

/** The model stopped to ASK PERMISSION instead of acting - same stall, politeness flavor. */
const WAITING_FOR_USER = [
  /just let me know/i,
  /\bshall i\b/i,
  /\bwant me to\b/i,
  /\bshould i\b/i,
  /let me know if/i,
  /\bawaiting (your|further|the author's)? ?(confirmation|instructions|approval|input)\b/i,
  /once (the author|you) confirms?/i,
  /no further action is pending/i,
  // Vietnamese
  /\bcho tôi biết\b/i,
  /\bnếu (bạn|cần) (muốn|xác nhận|thì)\b/i,
  /\bchờ (bạn|xác nhận|phản hồi)\b/i,
];

/** Explicit completion markers - never nudge these, the task IS done. */
const COMPLETION = /\bDONE\b|task complete|hoàn thành|completed successfully/i;

function isPlanning(text: string): boolean {
  return !COMPLETION.test(text) && PLANNING.some((re) => re.test(text));
}

function isWaitingForUser(text: string): boolean {
  return !COMPLETION.test(text) && WAITING_FOR_USER.some((re) => re.test(text));
}

interface StreamResult {
  content: any[];
  stop_reason: string;
}

async function callGateway(messages: any[], useTools: boolean, model: string, sessionId?: string): Promise<StreamResult> {
  // The session-id suffix gives each CLI session its own gateway key AND its
  // own long-lived web chat: resume keeps the same conversation, and gateway
  // restarts or CLI compaction re-sync the same chat instead of starting new.
  const wireModel = sessionId ? `${model}:${sessionId}` : model;
  const body: any = { model: wireModel, max_tokens: 8192, messages, stream: true };
  if (useTools) {
    const { TOOLS } = await import("./tools/registry.js");
    body.tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
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
      try {
        data = JSON.parse(dataLine.slice(5));
      } catch {
        continue;
      }

      if (event === "content_block_start") {
        const cb = data.content_block;
        blocks[data.index] = { type: cb.type, text: "", name: cb.name, id: cb.id, input: "" };
        if (cb.type === "text") process.stderr.write("[model] ");
      } else if (event === "content_block_delta") {
        const b = blocks[data.index];
        if (!b) continue;
        const d = data.delta;
        if (d.type === "text_delta") {
          b.text += d.text;
          process.stderr.write(d.text);
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
          try {
            input = JSON.parse(b.input || "{}");
          } catch {}
          content.push({ type: "tool_use", id: b.id, name: b.name, input });
          process.stderr.write(`\n[tool_use ${b.name}]\n`);
        }
      } else if (event === "message_delta") {
        if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      }
    }
  }

  return { content, stop_reason: stopReason };
}

export { isPlanning, isWaitingForUser };

export interface LoopOpts {
  onToolResult?: (name: string, preview: string) => void;
}

/**
 * Run turns until the model stops calling tools or the budget is exhausted.
 * Returns true when the task produced a final answer.
 */
export async function runTurn(
  session: Session,
  messages: any[],
  opts: LoopOpts = {}
): Promise<boolean> {
  const model = session.model || process.env.TABLM_MODEL || "web-zai";
  const ctx: ToolContext = { cwd: session.cwd };
  // consecutive narration-nudges in this run - reset whenever tools execute
  let nudges = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // pair-aware compaction happens BEFORE the call, on whole rounds
    const rounds = groupRounds(
      messages.flatMap((m) =>
        m.role === "assistant" && Array.isArray(m.content)
          ? m.content.map((b: any) =>
              b.type === "text"
                ? { type: "assistant_text", text: b.text, at: "" }
                : b.type === "tool_use"
                  ? { type: "tool_use", id: b.id, name: b.name, input: b.input, at: "" }
                  : null
            )
          : m.role === "user" && Array.isArray(m.content)
            ? m.content.map((b: any) =>
                b.type === "tool_result"
                  ? { type: "tool_result", toolUseId: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content), at: "" }
                  : null
              )
            : [{ type: m.role === "assistant" ? "assistant_text" : "user", text: typeof m.content === "string" ? m.content : "", at: "" }]
      ).filter(Boolean) as any[]
    );
    const plan = planCompaction(rounds);
    if (plan.compact) {
      process.stderr.write(
        `\n[compact] session too long (${totalChars(rounds)} chars) - compacting whole rounds\n`
      );
      messages.length = 0;
      messages.push({ role: "user", content: plan.summary });
      for (const r of plan.keep) {
        const blocks: any[] = [];
        if (r.assistantText) blocks.push({ type: "text", text: r.assistantText });
        for (const u of r.toolUses) blocks.push({ type: "tool_use", id: u.id, name: u.name, input: u.input });
        if (blocks.length) messages.push({ role: "assistant", content: blocks });
        for (const res of r.toolResults) {
          messages.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: res.toolUseId, content: res.content }],
          });
        }
      }
    }

    process.stderr.write(`\n--- turn ${turn + 1} [${model}] ---\n`);
    let response: StreamResult;
    try {
      response = await callGateway(messages, true, model, session.id);
    } catch (e: any) {
      console.error(`gateway error: ${e.message}`);
      return false;
    }

    const content = response.content;
    const toolUses = content.filter((b: any) => b.type === "tool_use");

    if (toolUses.length === 0) {
      const text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      // Planning prose OR permission-asking ("just let me know", "shall I...")
      // is a stall, not a final answer - push back regardless of whether the
      // task has started. Bounded: after 2 nudges accept the text.
      const waiting = isWaitingForUser(text);
      if ((isPlanning(text) || waiting) && nudges < 2) {
        nudges++;
        process.stderr.write(
          `\n[nudge ${nudges}/2] model ${waiting ? "asked permission" : "narrated"} instead of acting - pushing back\n`
        );
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: waiting
            ? "Yes - proceed. You run autonomously and never need confirmation. Emit the ```tooluse block for that action NOW."
            : "You described what you would do instead of doing it. Do NOT explain, plan, or announce batches. Emit the ```tooluse block for the NEXT concrete action NOW.",
        });
        continue;
      }
      console.log(text);
      return true;
    }
    nudges = 0; // the model is acting again

    messages.push({ role: "assistant", content });

    // enforce the parallel-call cap: execute the first N, give the rest a
    // protocol-valid tool_result telling the model to re-emit them next turn
    const executable = toolUses.slice(0, MAX_CALLS_PER_TURN);
    const skipped = toolUses.slice(MAX_CALLS_PER_TURN);

    for (const tu of executable) {
      const tool = toolMap.get(tu.name);
      const at = new Date().toISOString();
      appendEvent(session.id, { type: "tool_use", id: tu.id, name: tu.name, input: tu.input, at });

      let result: string;
      if (!tool) {
        result = `[error] unknown tool: ${tu.name}`;
      } else {
        // fail-closed: validate refuses unresolved payload markers
        if (tool.validate) {
          const refusal = tool.validate(tu.input);
          if (refusal) {
            result = `[error] ${refusal}`;
            process.stderr.write(`[refused] ${tu.name}: ${refusal}\n`);
            opts.onToolResult?.(tu.name, result.slice(0, 120));
            messages.push({
              role: "user",
              content: [{ type: "tool_result", tool_use_id: tu.id, content: result }],
            });
            appendEvent(session.id, { type: "tool_result", toolUseId: tu.id, content: result, at });
            continue;
          }
        }
        process.stderr.write(`[run] ${tu.name} ${JSON.stringify(tu.input).slice(0, 200)}\n`);
        try {
          result = await tool.run(tu.input, ctx);
        } catch (e: any) {
          result = `[error] ${e.message}`;
        }
      }
      // Bound each result before it enters history: a single 17K result (or ten
      // in one round) blows past every downstream cap and gets the task cut off.
      if (result.length > MAX_RESULT_CHARS) {
        result =
          result.slice(0, MAX_RESULT_CHARS) +
          `\n[...truncated ${result.length - MAX_RESULT_CHARS} chars - re-read a narrower range if needed]`;
      }
      process.stderr.write(`[result] ${result.slice(0, 300)}\n`);
      opts.onToolResult?.(tu.name, result.slice(0, 300));
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: tu.id, content: result }],
      });
      appendEvent(session.id, { type: "tool_result", toolUseId: tu.id, content: result, at });
    }

    for (const tu of skipped) {
      const result = `[skipped] per-turn limit is ${MAX_CALLS_PER_TURN} parallel tool calls; this call was not executed. Re-emit it in your next response.`;
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: tu.id, content: result }],
      });
      appendEvent(session.id, { type: "tool_result", toolUseId: tu.id, content: result, at: new Date().toISOString() });
    }
    if (skipped.length) {
      process.stderr.write(`[cap] executed ${executable.length}, skipped ${skipped.length} parallel calls\n`);
    }
  }
  console.error(`reached max turns (${MAX_TURNS})`);
  return false;
}
