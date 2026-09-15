// @@TABLM payload blocks: "@@TABLM <id> <key> <<'EOF'" ... "@@TABLM_END <id>"
// A payload lets the model emit a large string argument as RAW text after the
// JSON tool-call header, so it never has to JSON-escape newlines/quotes/braces.

export interface PayloadFind {
  /** raw verbatim content, or null when the block is missing or truncated */
  content: string | null;
  /** index just past the END marker, or -1 when absent/truncated */
  end: number;
}

const OPEN = (id: string, key: string) =>
  new RegExp(`@@TABLM[ \\t]+${id}[ \\t]+${key}[ \\t]*<<'EOF'`);

const CLOSE = (id: string) => new RegExp(`\\r?\\n@@TABLM_END[ \\t]+${id}\\b`);

/**
 * Locate a payload block for (id, key), searching forward from `from`.
 * Returns content:null when the opening marker is missing OR when the closing
 * marker is missing (truncated output) - callers must treat both as "not usable".
 */
export function findPayload(text: string, from: number, id: string, key: string): PayloadFind {
  const open = OPEN(id, key);
  const m = open.exec(text.slice(from));
  if (!m) return { content: null, end: -1 };
  const start = from + m.index + m[0].length;
  const c = CLOSE(id).exec(text.slice(start));
  if (!c) return { content: null, end: -1 }; // truncated: END marker missing
  // strip exactly one leading newline (the one right after the <<'EOF' line)
  const raw = text.slice(start, start + c.index).replace(/^\r?\n/, "");
  return { content: raw, end: start + c.index + c[0].length };
}

export function payloadMarkerRegex(): RegExp {
  return /^@payload:([A-Za-z0-9_]+)$/;
}

/** True when a string value is a payload reference like "@payload:content". */
export function isPayloadRef(value: unknown): boolean {
  return typeof value === "string" && payloadMarkerRegex().test(value.trim());
}

export function payloadKey(value: string): string | null {
  const m = payloadMarkerRegex().exec(value.trim());
  return m ? m[1] : null;
}

/**
 * Restore markdown-fence placeholders inside resolved payload content.
 *
 * The web UI renders the model's response as markdown before we extract it,
 * so literal ``` inside a payload CLOSES the model's own code fence and the
 * remainder of the payload gets markdown-stripped. The contract (v5) tells
 * the model to write @TBF@ instead; this restores the real backticks after
 * the payload has been resolved verbatim. Only called on payload content,
 * so a stray @TBF@ in normal prose is never touched.
 */
export function restorePayloadPlaceholders(content: string): string {
  return content.replace(/@TBF@/g, "```");
}

/**
 * Merge a truncated payload with its continuation. The model often repeats a
 * few characters/lines from before the cut, so we detect the maximal overlap
 * between the tail of the original and the head of the continuation.
 */
export function mergePayload(original: string, cont: string, id: string, key: string): string {
  const open = OPEN(id, key);
  const m = open.exec(original);
  if (!m) return original + cont;
  const markerEnd = m.index + m[0].length;
  const partial = original.slice(markerEnd); // raw payload so far (no END yet)
  let tail = cont;
  const contMarker = new RegExp(
    `^[\\s\\S]{0,200}?@@TABLM[ \\t]+${id}[ \\t]+${key}[ \\t]*<<'EOF'\\r?\\n?`
  );
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
  const endRe = new RegExp(`\\r?\\n@@TABLM_END[ \\t]+${id}\\s*$`);
  const body = mergedPayload.replace(endRe, "");
  return original.slice(0, markerEnd) + body + `\n@@TABLM_END ${id}`;
}
