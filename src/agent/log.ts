// Append-only session log.
//
// Replaces the old "messages array rewritten on every save" approach. Events
// are appended as JSONL: compaction is a first-class event, and round-trips
// (tool_use + its tool_results) are grouped by rounds.ts, never split.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export type LogEvent =
  | { type: "user"; text: string; at: string }
  | { type: "assistant_text"; text: string; at: string }
  | { type: "tool_use"; id: string; name: string; input: any; at: string }
  | { type: "tool_result"; toolUseId: string; content: string; at: string }
  | { type: "compact"; summary: string; at: string }
  /** failed gateway turn - logged for postmortem, NEVER sent to the model */
  | { type: "attempt"; status: "error" | "timeout"; detail: string; at: string };

export interface Session {
  id: string;
  created: string;
  updated: string;
  cwd: string;
  model: string;
  prompt: string;
}

const SESSIONS_DIR = path.join(homedir(), ".tablm", "cli-sessions");

export function sessionsDir(): string {
  return SESSIONS_DIR;
}

export function genSessionId(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
}

export function logPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.jsonl`);
}

export function metaPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.meta.json`);
}

export function appendEvent(id: string, ev: LogEvent): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(logPath(id), JSON.stringify(ev) + "\n", { flag: "a" });
}

export function readEvents(id: string): LogEvent[] {
  try {
    const raw = readFileSync(logPath(id), "utf8");
    const out: LogEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export function loadMeta(id: string): Session | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf8"));
  } catch {
    return null;
  }
}

export function saveMeta(s: Session): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  s.updated = new Date().toISOString();
  writeFileSync(metaPath(s.id), JSON.stringify(s, null, 2));
}

export function listSessions(): { id: string; meta: Session | null; events: number }[] {
  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => {
        const id = f.replace(/\.meta\.json$/, "");
        return { id, meta: loadMeta(id), events: readEvents(id).length };
      })
      .filter((x) => x.meta)
      .sort((a, b) => (b.meta!.updated || "").localeCompare(a.meta!.updated || ""));
  } catch {
    return [];
  }
}
