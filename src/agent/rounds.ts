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
      rounds.push({ assistantText: ev.summary, toolUses: [], toolResults: [] });
      continue;
    }
    if (ev.type === "assistant_text") {
      if (!current) current = { assistantText: ev.text, toolUses: [], toolResults: [] };
      else current.assistantText = (current.assistantText ?? "") + ev.text;
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

const COMPACT_THRESHOLD_CHARS = 50_000;
const COMPACT_KEEP_ROUNDS = 6;

function roundChars(r: Round): number {
  let n = (r.assistantText ?? "").length;
  for (const u of r.toolUses) n += JSON.stringify(u.input ?? {}).length;
  for (const r2 of r.toolResults) n += r2.content.length;
  return n;
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
  const toSummarize = rounds.slice(0, rounds.length - keepCount);
  const keep = rounds.slice(rounds.length - keepCount);

  const parts: string[] = [];
  for (const r of toSummarize) {
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
