// Turn-outcome classification and deterministic repair.
//
// Every model turn is classified into one of: OK / NARRATED / TRUNCATED_PAYLOAD /
// TRUNCATED_JSON / REFUSED. Each failure class has exactly one repair strategy,
// and repairs run under a strict budget so the loop provably terminates instead
// of retrying forever (the old code could burn unbounded browser round-trips).

import { parseToolCalls, type ParseResult, type ParsedCall } from "./parse.js";
import { mergePayload } from "./payload.js";
import {
  narrationCorrection,
  payloadMissingCorrection,
} from "./contract.js";

export type TurnKind =
  | "ok"
  | "narrated"
  | "truncated_payload"
  | "truncated_json"
  | "refused"
  | "error";

export interface TurnOutcome {
  kind: TurnKind;
  /** calls that are ready to execute (payloads resolved) */
  calls: ParsedCall[];
  /** calls blocked because a payload ref did not resolve - DO NOT execute */
  blocked: ParsedCall[];
  cleanText: string;
  /** ids needing a payload-continuation repair, if any */
  truncated: { id: string; key: string }[];
}

/** A model turn that looks like planning/excuse prose instead of a tool call. */
const NARRATION_PATTERNS = [
  /\bI have (most of|a good|the) (picture|context|understanding)/i,
  /\bLet me (read|check|look at|examine|see|understand|gather)/i,
  /\bI('ll| will) (read|check|look at|examine|see|gather|start)/i,
  /\bbefore (I|making|we) (make|change|edit|write|commit)/i,
  /\b(?:restoring|recovering) via heredoc instead/i,
  /\bthe payload didn'?t attach/i,
  /\bI can['’']t|cannot |unable to |Work mode|Cloud Browser\b/i,
  /I (?:couldn'?t|was unable to) (?:complete|post|run|finish)/i,
];

function classifyNarrated(text: string): boolean {
  return NARRATION_PATTERNS.some((re) => re.test(text));
}

export function classify(parsed: ParseResult, rawText: string): TurnOutcome {
  const usable = parsed.calls.filter((c) => c.unresolved.length === 0);
  const blocked = parsed.calls.filter((c) => c.unresolved.length > 0);

  if (blocked.length) {
    return {
      kind: "narrated",
      calls: [],
      blocked,
      cleanText: parsed.cleanText,
      truncated: parsed.truncated,
    };
  }
  if (usable.length) {
    return { kind: "ok", calls: usable, blocked: [], cleanText: parsed.cleanText, truncated: parsed.truncated };
  }
  if (parsed.truncated.length) {
    return { kind: "truncated_payload", calls: [], blocked: [], cleanText: parsed.cleanText, truncated: parsed.truncated };
  }
  // orphan payload: a @@TABLM body exists but no JSON header was parsed - the
  // model pasted content where the {"id":...} line belonged
  const orphanPayload = /@@TABLM[ \t]+[A-Za-z0-9_]+[ \t]+[A-Za-z0-9_]+[ \t]*<<'EOF'/.test(rawText);
  if (orphanPayload) {
    return { kind: "truncated_payload", calls: [], blocked: [], cleanText: parsed.cleanText, truncated: parsed.truncated };
  }
  // a tooluse/json header exists but no call parsed -> likely mid-JSON truncation
  const startedToolCall = /```tooluse|```json|tooluse\s*\n?\s*\{|"\s*name\s*"\s*:\s*"/i.test(rawText);
  if (startedToolCall) return { kind: "truncated_json", calls: [], blocked: [], cleanText: parsed.cleanText, truncated: [] };
  if (classifyNarrated(rawText)) return { kind: "narrated", calls: [], blocked: [], cleanText: parsed.cleanText, truncated: [] };
  return { kind: "ok", calls: [], blocked: [], cleanText: parsed.cleanText, truncated: [] };
}

/** Repair a truncated payload by asking for the raw continuation and merging. */
export async function repairTruncatedPayload(
  rawText: string,
  truncated: { id: string; key: string }[],
  ask: (prompt: string) => Promise<string>
): Promise<string | null> {
  if (!truncated.length) return null;
  const t = truncated[0];
  const continuation =
    `Continue. Your previous response was cut off inside a payload block for tool call ${t.id}, field ${t.key}. ` +
    `Output ONLY the remaining raw content of that payload, resuming exactly where you stopped. ` +
    `Do NOT repeat the beginning, do NOT repeat the @@TABLM marker line. When done, end the payload with a line containing exactly: @@TABLM_END ${t.id}`;
  const cont = await ask(continuation);
  if (!cont) return null;
  const merged = mergePayload(rawText, cont, t.id, t.key);
  const reparsed = parseToolCalls(merged);
  if (reparsed.calls.length && !reparsed.truncated.length) return merged;
  return null;
}

/** Repair a truncated JSON header by asking for the remainder and concatenating. */
export async function repairTruncatedJson(
  rawText: string,
  ask: (prompt: string) => Promise<string>
): Promise<string | null> {
  const continuation =
    "Continue. Your previous response was cut off. Output ONLY the remaining part of the JSON tool call, " +
    "starting from where you stopped. Do NOT repeat the beginning.";
  const cont = await ask(continuation);
  if (!cont) return null;
  const merged = rawText + cont;
  if (parseToolCalls(merged).calls.length) return merged;
  return null;
}

/**
 * Mine the narrated text for the shell command the model DESCRIBED but never
 * ran. Reflecting it back as a ready-to-emit block converts a stall into one
 * round trip: the model no longer has to invent the tool call format.
 */
const NEGATION = /\b(not installed|command not found|does not resolve|no (credentials|access)|cannot be found|unavailable)\b/i;

export function extractNarratedCommand(text: string): string | null {
  const cleaned = text.replace(/```[a-z]*\n?/gi, "");
  const re = /^\s*(?:[$>]+\s*)?((?:[A-Z_]+=\S+\s+)?(?:gh|git|npm|npx|node|python3?|curl|cat|ls|find|rg|sed|awk|head|tail|grep|echo|make|docker|kubectl|wc)\b.*)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const cmd = m[1].trim();
    // skip prose-negation lines like "gh is not installed (gh: command not found)"
    if (NEGATION.test(cmd) || cmd.length < 3 || cmd.length > 300) continue;
    return cmd;
  }
  return null;
}

export function repairPromptFor(
  kind: TurnKind,
  blocked: ParsedCall[],
  fullPrompt: string,
  rawText = ""
): string {
  if (kind === "narrated" && blocked.length) {
    const b = blocked[0];
    const key = b.unresolved[0];
    return `${fullPrompt}\n\n${payloadMissingCorrection(b.id || "1", key, b.name)}`;
  }
  if (kind === "narrated") {
    const cmd = extractNarratedCommand(rawText) ?? extractNarratedCommand(fullPrompt);
    if (cmd) {
      const block = JSON.stringify({ id: "t1", name: "Bash", input: { command: cmd } });
      return (
        `${fullPrompt}\n\n[System correction] You wrote that \`${cmd}\` returned a result. It did NOT run - no tool call was emitted, so nothing executed. ` +
        `Also: gh, git and npm are preinstalled on this machine - never install packages. ` +
        `To actually run your command, emit EXACTLY this block and nothing else:\n\`\`\`tooluse\n${block}\n\`\`\``
      );
    }
  }
  return `${fullPrompt}\n\n${narrationCorrection()}`;
}

