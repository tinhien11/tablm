// Parses the model's textual tool-call output back into structured calls.
//
// Contract lives in contract.ts; this module must stay in sync with it.
// FAIL-CLOSED RULE: a call whose "@payload:KEY" reference cannot be resolved
// is returned as unresolved: true. Callers MUST NOT execute such a call -
// executing it would write the literal 16-char placeholder to a file.

import { findPayload, isPayloadRef, payloadKey, restorePayloadPlaceholders } from "./payload.js";

export interface ParsedCall {
  name: string;
  input: any;
  /** stable id the model chose (t1, t2, ...) - used to locate payloads */
  id: string;
  /** payload refs that did NOT resolve - the call is unusable, do not run it */
  unresolved: string[];
}

export interface ParseResult {
  calls: ParsedCall[];
  /** prose with all tool-call blocks stripped */
  cleanText: string;
  /** payload blocks whose END marker was missing (truncated output) */
  truncated: { id: string; key: string }[];
}

const FENCE_OPEN = "```tooluse";
const JSON_FENCE = "```json";

/**
 * Extract a balanced {...} object starting at/after `from`, honoring string
 * and escape state. Returns null when truncated (no balancing close brace).
 */
export function extractJsonObject(text: string, from: number): string | null {
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
  return null; // truncated mid-object
}

function parseCallObject(obj: string): { id: string; name: string; input: any } | null {
  let parsed: any;
  try {
    parsed = JSON.parse(obj);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.name !== "string") return null;
  const id = typeof parsed.id === "string" ? parsed.id : "";
  const input = parsed.input && typeof parsed.input === "object" ? parsed.input : {};
  return { id, name: parsed.name, input };
}

/**
 * Resolve every "@payload:KEY" string field against the ORIGINAL text.
 * The fence regex is non-greedy and may stop at a ``` INSIDE the raw payload,
 * so payloads are searched forward from the fence start, not inside the region.
 *
 * Returns the list of payload keys that failed to resolve (missing or truncated).
 */
function resolvePayloads(
  text: string,
  from: number,
  call: { id: string; name: string; input: any },
  truncatedOut: { id: string; key: string }[]
): string[] {
  const unresolved: string[] = [];
  for (const [k, v] of Object.entries(call.input)) {
    if (!isPayloadRef(v)) continue;
    const key = payloadKey(v as string)!;
    const found = findPayload(text, from, call.id || "1", key);
    if (found.content !== null) {
      call.input[k] = restorePayloadPlaceholders(found.content);
    } else {
      unresolved.push(key);
      truncatedOut.push({ id: call.id || "1", key });
    }
  }
  return unresolved;
}

/**
 * Index just past the END marker of any payload belonging to `id`, searched
 * forward from `from`. Used to keep the fence regex from re-matching content
 * that lives inside a raw payload block.
 */
function payloadEndAfter(text: string, from: number, id: string): number {
  let end = -1;
  const open = new RegExp(`@@TABLM[ \\t]+${id}[ \\t]+[A-Za-z0-9_]+[ \\t]*<<'EOF'`);
  let searchFrom = from;
  for (;;) {
    const m = open.exec(text.slice(searchFrom));
    if (!m) break;
    const markerStart = searchFrom + m.index;
    // reuse findPayload's END-marker handling by re-deriving key from the match
    const keyMatch = /@@TABLM[ \t]+[A-Za-z0-9_ \t]*?([A-Za-z0-9_]+)[ \t]*<<'EOF'/.exec(m[0]);
    const key = keyMatch ? keyMatch[1] : "";
    const found = findPayload(text, markerStart, id, key);
    if (found.end > end) end = found.end;
    searchFrom = markerStart + m[0].length;
  }
  return end;
}

export function parseToolCalls(text: string): ParseResult {
  const calls: ParsedCall[] = [];
  const truncated: { id: string; key: string }[] = [];
  let firstMarker = -1;

  const recordMarker = (i: number) => {
    if (firstMarker < 0) firstMarker = i;
  };

  // 1. ```tooluse fences (primary format)
  const re = new RegExp("```tooluse\\s*\\n?([\\s\\S]*?)```", "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    recordMarker(m.index);
    const obj = extractJsonObject(m[1], 0);
    if (!obj) continue;
    const call = parseCallObject(obj);
    if (!call) continue;
    const unresolved = resolvePayloads(text, m.index, call, truncated);
    calls.push({ ...call, unresolved });
    // advance past a resolved payload so a ``` INSIDE the raw content can't be
    // re-matched as the start of a new tool call
    const after = payloadEndAfter(text, m.index, call.id || "1");
    if (after > re.lastIndex) re.lastIndex = after;
  }

  // 2. ```json fences (ChatGPT style)
  if (!calls.length) {
    const jsonRe = new RegExp("```json\\s*\\n?([\\s\\S]*?)```", "g");
    while ((m = jsonRe.exec(text)) !== null) {
      recordMarker(m.index);
      const call = parseCallObject(m[1]);
      if (!call) continue;
      calls.push({ ...call, unresolved: [] });
    }
  }

  // 3. Bare JSON (web chat stripped backticks) - includes the "tooluse\n{...}" shape
  if (!calls.length) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const obj = extractJsonObject(text, searchFrom);
      if (!obj) break;
      const startAt = text.indexOf(obj, searchFrom);
      recordMarker(startAt);
      const call = parseCallObject(obj);
      if (call) {
        const unresolved = resolvePayloads(text, startAt, call, truncated);
        calls.push({ ...call, unresolved });
      }
      searchFrom = startAt + obj.length;
    }
  }

  // 4. Orphan payload: the model emitted a @@TABLM body but its JSON header was
  // missing (often it pastes the content where the {"id":...} line belonged).
  // We cannot know the tool name, so we surface it as a repair hint instead of
  // silently dropping it - the caller tells the model to re-emit the header.
  if (!calls.length) {
    const orphan = /@@TABLM[ \t]+([A-Za-z0-9_]+)[ \t]+([A-Za-z0-9_]+)[ \t]*<<'EOF'/.exec(text);
    if (orphan) {
      truncated.push({ id: orphan[1], key: orphan[2] });
    }
  }

  const cutCandidates = [
    text.indexOf(FENCE_OPEN),
    text.indexOf(JSON_FENCE),
    text.indexOf("tooluse\n{"),
    text.indexOf("tooluse {"),
    firstMarker,
  ].filter((i) => i >= 0);
  const cleanText = calls.length
    ? text.slice(0, cutCandidates.length ? Math.min(...cutCandidates) : text.length).trim()
    : text.trim();

  return { calls, cleanText, truncated };
}
