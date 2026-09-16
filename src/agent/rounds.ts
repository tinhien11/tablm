// Round grouping and pair-aware compaction.
//
// A "round" is an assistant utterance plus the tool calls it made and their
// results. Rounds are atomic: compaction always folds WHOLE rounds into a
// summary, so a tool_result can never be orphaned from its tool_use (the bug
// that corrupted the 20260915-1445 session with a hallucinated tool_result).

import type { LogEvent } from "./log.js";

export interface Round {
  assistantText?: string;
  toolUses: { id: string; name: string; input: any }[];
  toolResults: { toolUseId: string; content: string }[];
  /** round synthesized from a compact event - renders as USER role, not assistant */
  fromCompact?: boolean;
}

export function groupRounds(events: LogEvent[]): Round[] {
  const rounds: Round[] = [];
  let current: Round | null = null;
  const pendingResults: Round["toolResults"] = [];

  const flushPending = () => {
    if (current && pendingResults.length) {
      current.toolResults.push(...pendingResults.splice(0));
    }
  };

  for (const ev of events) {
    if (ev.type === "user") {
      // a new user turn closes the current round
      if (current) {
        flushPending();
        rounds.push(current);
        current = null;
      }
      continue;
    }
    if (ev.type === "compact") {
      if (current) {
        flushPending();
        rounds.push(current);
        current = null;
      }
      rounds.push({ assistantText: ev.summary, toolUses: [], toolResults: [], fromCompact: true });
      continue;
    }
    if (ev.type === "assistant_text") {
      // an assistant utterance AFTER tool activity starts a new round; only
      // consecutive text deltas merge into the same round
      if (current && (current.toolUses.length || current.toolResults.length)) {
        rounds.push(current);
        current = { assistantText: ev.text, toolUses: [], toolResults: [] };
      } else if (!current) {
        current = { assistantText: ev.text, toolUses: [], toolResults: [] };
      } else {
        current.assistantText = (current.assistantText ?? "") + ev.text;
      }
      continue;
    }
    if (ev.type === "tool_use") {
      if (!current) current = { toolUses: [], toolResults: [] };
      current.toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
      continue;
    }
    if (ev.type === "tool_result") {
      if (!current) {
        // orphaned result with no preceding tool_use - attach to the last round
        const last = rounds[rounds.length - 1];
        if (last) last.toolResults.push({ toolUseId: ev.toolUseId, content: ev.content });
        continue;
      }
      current.toolResults.push({ toolUseId: ev.toolUseId, content: ev.content });
    }
  }
  if (current) {
    flushPending();
    rounds.push(current);
  }
  return rounds;
}

// Compaction sizing. All env-tunable: long-running sessions should compact
// LATE (big threshold, generous keep budget) - compacting early re-syncs a
// ~60K context paste into the web chat, which inflates its rollover counter
// and starts new chats prematurely.
const COMPACT_THRESHOLD_CHARS = Number(process.env.TABLM_COMPACT_THRESHOLD_CHARS || 150_000);
const COMPACT_KEEP_ROUNDS = 8;
/** Post-compaction budget for the kept (recent) rounds. */
const KEEP_BUDGET_CHARS = Number(process.env.TABLM_COMPACT_KEEP_BUDGET || 60_000);
/** Per-result cap inside kept rounds - bounds a single monster round. */
const KEPT_RESULT_CHARS = Number(process.env.TABLM_KEPT_RESULT_CHARS || 6_000);

function roundChars(r: Round): number {
  let n = (r.assistantText ?? "").length;
  for (const u of r.toolUses) n += JSON.stringify(u.input ?? {}).length;
  for (const r2 of r.toolResults) n += r2.content.length;
  return n;
}

/** Shrink oversized results inside kept rounds (oldest results first). */
function clampRound(r: Round): Round {
  const toolResults = r.toolResults.map((res) =>
    res.content.length > KEPT_RESULT_CHARS
      ? {
          ...res,
          content:
            res.content.slice(0, KEPT_RESULT_CHARS) +
            `[...clamped ${res.content.length - KEPT_RESULT_CHARS} chars]`,
        }
      : res
  );
  return { ...r, toolResults };
}

export function totalChars(rounds: Round[]): number {
  return rounds.reduce((a, r) => a + roundChars(r), 0);
}

/**
 * Compact when the history exceeds the threshold. Whole rounds (not arbitrary
 * message counts) are folded into ONE summary event; the most recent rounds are
 * kept verbatim. The summary is a first-class compact event, never re-fed into
 * another summary, so summaries cannot nest.
 */
export function planCompaction(rounds: Round[]): {
  compact: boolean;
  summary: string;
  keep: Round[];
} {
  if (totalChars(rounds) < COMPACT_THRESHOLD_CHARS) {
    return { compact: false, summary: "", keep: rounds };
  }
  const keepCount = Math.min(COMPACT_KEEP_ROUNDS, rounds.length);
  let keep = rounds.slice(rounds.length - keepCount);

  // The recent rounds alone can exceed the whole budget (one round of 10
  // parallel tool calls produced ~60K of results). Clamp oversized results
  // inside kept rounds, then drop oldest kept rounds into the summary until
  // the kept tail fits the budget - the kept tail is guaranteed bounded.
  keep = keep.map(clampRound);
  while (keep.length > 1 && totalChars(keep) > KEEP_BUDGET_CHARS) {
    keep = keep.slice(1);
  }

  // everything not kept - originally-old rounds AND rounds dropped from the
  // kept tail - goes into one flat summary (never nested, never re-summarized)
  const parts: string[] = [];
  for (const r of rounds.slice(0, rounds.length - keep.length)) {
    if (r.assistantText) parts.push(`Assistant: ${r.assistantText.slice(0, 200)}`);
    for (const u of r.toolUses) {
      parts.push(`Assistant called ${u.name}(${JSON.stringify(u.input ?? {}).slice(0, 100)})`);
    }
    for (const res of r.toolResults) {
      parts.push(`Tool result: ${res.content.slice(0, 200)}`);
    }
  }
  const summary =
    `[Session compacted. Previous conversation summary:\n${parts.join("\n")}\nEnd of summary. Continue from here.]`;
  return { compact: true, summary, keep };
}

/**
 * THE canonical projection from the event log to gateway messages.
 *
 * Live loop, compaction rebuild and --resume all render through this one
 * function. Three independent mappers drifting apart was the resume-shape
 * desync bug; this is the dsh "model-visible means logged" invariant adapted:
 * everything the model sees is derived from the log, everything logged and
 * model-visible derives through here. Attempt events are logged but never
 * model-visible, so they are dropped by design.
 */
export function deriveMessages(events: LogEvent[]): any[] {
  // Single-pass projection - user messages included. groupRounds is for SIZE
  // accounting; this is the model-context walk, and dropping user turns here
  // was exactly the bug that made --resume lose the original task.
  let lastCompact = -1;
  events.forEach((e, i) => {
    if (e.type === "compact") lastCompact = i;
  });
  const slice = lastCompact === -1 ? events : events.slice(lastCompact + 1);
  const out: any[] = [];
  if (lastCompact !== -1) {
    out.push({ role: "user", content: (events[lastCompact] as { summary: string }).summary });
  }
  let blocks: any[] | null = null; // current assistant message under construction
  const flush = () => {
    if (blocks) {
      out.push({ role: "assistant", content: blocks });
      blocks = null;
    }
  };
  for (const ev of slice) {
    if (ev.type === "user") {
      flush();
      out.push({ role: "user", content: ev.text });
    } else if (ev.type === "assistant_text") {
      if (!blocks) {
        blocks = [{ type: "text", text: ev.text }];
      } else if (blocks.some((b) => b.type === "tool_use")) {
        // text after tools = the model's next utterance, own message
        flush();
        blocks = [{ type: "text", text: ev.text }];
      } else {
        blocks[0].text += ev.text; // streaming deltas of the same utterance
      }
    } else if (ev.type === "tool_use") {
      if (!blocks) blocks = [];
      blocks.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
    } else if (ev.type === "tool_result") {
      flush();
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: ev.toolUseId, content: ev.content }],
      });
    }
    // attempt events: logged, never model-visible
  }
  flush();
  return out;
}
