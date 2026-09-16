// Persistent mapping of tablm session keys -> web-chat conversation ids.
// Kept in its own module so driver.ts stops owning a JSON file format.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";

function sessionsFile(): string {
  return config.sessionsFile || path.join(os.homedir(), ".tablm", "sessions.json");
}

const sessions: Record<string, string> = (() => {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(), "utf8"));
  } catch {
    return {};
  }
})();

export function getSession(key: string): string | undefined {
  return sessions[key];
}

export function rememberSession(key: string, conversationId: string | null): void {
  if (!conversationId) return;
  sessions[key] = conversationId;
  try {
    fs.mkdirSync(path.dirname(sessionsFile()), { recursive: true });
    fs.writeFileSync(sessionsFile(), JSON.stringify(sessions, null, 2));
  } catch {}
}
