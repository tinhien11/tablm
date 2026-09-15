// Web-chat conversation state.
//
// The browser tab holds the real conversation; we only paste the NEW turns.
// This module tracks which messages we have already sent to each web chat so
// a delta prompt can contain just the tail. State lives in memory (a gateway
// process owns one conversation per site:session) and is keyed by message
// signature, so identical history never re-pastes.

import { toolProtocol, toolReminder } from "../protocol/contract.js";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + " [...truncated]";
}

const MAX_PROMPT_CHARS = 60_000;
const MAX_SYSTEM_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 8_000;
const MAX_TOOL_USE_INPUT_CHARS = 2_000;

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
      if (b?.type === "tool_use")
        return `[tool_use ${b.name}] ${truncate(JSON.stringify(b.input ?? {}), MAX_TOOL_USE_INPUT_CHARS)}`;
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

export function buildFullPrompt(body: any): string {
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
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (hasTools) {
    const proto = toolProtocol(body.tools);
    toolProtoLen = proto.length;
    parts.push(`[Tool use protocol]\n${proto}`);
  }
  parts.push("Assistant:\n");
  let prompt = parts.join("\n\n");
  if (prompt.length > MAX_PROMPT_CHARS) {
    // Keep the HEAD (system + original task) and the TAIL (recent turns);
    // truncate the middle. Tail-only truncation cut off the task itself and
    // the web model replied "the original task isn't visible - nothing to act on".
    const headKeep = 12_000;
    const tailKeep = MAX_PROMPT_CHARS - headKeep - 200;
    prompt =
      prompt.slice(0, headKeep) +
      "\n[...middle of the pasted history truncated - the task and recent turns follow...]\n" +
      prompt.slice(-tailKeep);
  }
  console.log(
    `[gateway] full prompt breakdown: system=${sysLen} msgs=${msgsLen} toolProto=${toolProtoLen} tools=${body.tools?.length ?? 0} total=${prompt.length}`
  );
  return prompt;
}

function msgSig(m: any): string {
  return `${m.role ?? "user"}\u0000${textFromContent(m.content)}`;
}

interface ConvState {
  sigs: string[];
  protocolSent: boolean;
  /** chars pasted into the web chat so far - drives late rollover */
  pasted: number;
}

const conv = new Map<string, ConvState>();

/** Start a fresh web chat only after this much has been pasted into the current one. */
function rolloverChars(): number {
  return Number(process.env.TABLM_CHAT_ROLLOVER_CHARS || 400_000);
}

export interface BuiltPrompt {
  prompt: string;
  mode: "delta" | "full";
  /** a web conversation already exists for this key */
  hadConversation: boolean;
  /** the existing chat crossed the rollover threshold - start a new one */
  rolloverDue: boolean;
  /** history diverged from what the chat already contains - prefix a re-sync note */
  resync: boolean;
}

/**
 * Build the prompt to paste into the web chat. Reuses a stored signature list
 * to send only the new tail (delta) when the history is a superset of what we
 * already sent. On divergence (CLI compaction, resume) the SAME chat is kept
 * and the prompt is marked as a re-sync - a new chat is started only for a
 * brand-new conversation or when the current one crosses the rollover budget.
 */
export function buildPrompt(body: any, key: string): BuiltPrompt {
  const msgs: any[] = body.messages ?? [];
  const sigs = msgs.map(msgSig);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const prev = conv.get(key);

  if (prev && sigs.length >= prev.sigs.length) {
    let lcp = 0;
    const n = Math.min(prev.sigs.length, sigs.length);
    while (lcp < n && prev.sigs[lcp] === sigs[lcp]) lcp++;
    if (lcp >= prev.sigs.length - 1 && sigs.length > lcp) {
      const delta = msgs.slice(lcp);
      let text = formatMessages(delta);
      // an oversized delta would bypass the full-mode prompt cap entirely -
      // fall through to the full rebuild, which truncates the middle instead.
      // Same fall-through when the chat crossed its rollover budget: the
      // "delta" becomes the seed of a FRESH chat (gom) instead of more of the same.
      if (
        text.trim() &&
        text.length <= MAX_PROMPT_CHARS &&
        prev.pasted <= rolloverChars()
      ) {
        if (hasTools && !prev.protocolSent) {
          const out = `[Tool use protocol]\n${toolProtocol(body.tools)}\n\n${text}`;
          conv.set(key, { sigs, protocolSent: true, pasted: prev.pasted + out.length });
          console.log(`[gateway] ${key} tool protocol injected (delta)`);
          return { prompt: out, mode: "delta", hadConversation: true, rolloverDue: false, resync: false };
        }
        if (hasTools) text += toolReminder();
        conv.set(key, { sigs, protocolSent: prev.protocolSent, pasted: prev.pasted + text.length });
        return { prompt: text, mode: "delta", hadConversation: true, rolloverDue: false, resync: false };
      }
    }
  }

  const hadConversation = prev !== undefined;
  const rolloverDue = hadConversation && prev!.pasted > rolloverChars();
  let prompt = buildFullPrompt(body);
  // diverged but the chat is young enough: keep it and mark the paste as a
  // re-sync so the model treats it as the current state, not duplication
  const resync = hadConversation && !rolloverDue;
  if (resync) {
    prompt =
      "[Context re-synced - this message is the current authoritative state; it supersedes overlapping details earlier in this conversation.]\n\n" +
      prompt;
  }
  const state: ConvState = { sigs, protocolSent: hasTools, pasted: prompt.length };
  conv.set(key, state);
  return { prompt, mode: "full", hadConversation, rolloverDue, resync };
}

export function siteFromModel(model: string | undefined): { site: string; session?: string } {
  const m = String(model ?? "");
  const match = /^web-([a-z0-9_-]+?)(?::([a-z0-9_-]+))?$/i.exec(m);
  if (match) return { site: match[1], session: match[2] };
  return { site: process.env.TABLM_DEFAULT_SITE || "zai" };
}

export function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}
