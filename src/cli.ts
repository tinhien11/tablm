#!/usr/bin/env node
// tablm entrypoint (built-in chat CLI). Thin: parsing here, work in src/agent.

import {
  genSessionId,
  listSessions,
  loadMeta,
  readEvents,
  saveMeta,
  appendEvent,
  type Session,
} from "./agent/log.js";
import { repl } from "./agent/repl.js";
import { closeScratchPage } from "./agent/tools/registry.js";
import { groupRounds } from "./agent/rounds.js";

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--list" || args[0] === "-l") {
    const sessions = listSessions();
    if (!sessions.length) {
      console.log("no saved sessions");
      process.exit(0);
    }
    console.log("saved sessions (newest first):");
    for (const s of sessions) {
      const age = s.meta?.updated ? new Date(s.meta.updated).toLocaleString() : "?";
      const preview = s.meta?.prompt?.slice(0, 60) ?? "(no prompt)";
      console.log(`  ${s.id}  ${age}  ${s.events} events  [${s.meta?.cwd}]  "${preview}"`);
    }
    process.exit(0);
  }

  if (args[0] === "--models") {
    console.log("available models:");
    console.log("  web-zai     chat.z.ai (GLM) - default");
    console.log("  web-chatgpt chatgpt.com");
    console.log("  web-kimi    kimi.ai (login required)");
    process.exit(0);
  }

  let model = process.env.TABLM_MODEL || "web-zai";
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    model = args[modelIdx + 1];
    args.splice(modelIdx, 2);
  }
  const mIdx = args.indexOf("-m");
  if (mIdx !== -1 && args[mIdx + 1]) {
    model = args[mIdx + 1];
    args.splice(mIdx, 2);
  }

  let session: Session;
  let initialPrompt: string | undefined;

  if (args[0] === "--resume" || args[0] === "-r") {
    const id = args[1];
    if (!id) {
      console.error("usage: tablm --resume <session-id> [follow-up prompt]");
      process.exit(1);
    }
    const loaded = loadMeta(id);
    if (!loaded) {
      console.error(`session not found: ${id}`);
      console.error("run: tablm --list");
      process.exit(1);
    }
    session = loaded;
    session.model = model;
    initialPrompt = args.slice(2).join(" ") || undefined;
    process.stderr.write(`[resume] session ${id} (${readEvents(id).length} events, cwd: ${session.cwd})\n`);
  } else {
    initialPrompt = args.join(" ") || undefined;
    const now = new Date().toISOString();
    session = {
      id: genSessionId(),
      created: now,
      updated: now,
      cwd: process.cwd(),
      model,
      prompt: initialPrompt ?? "",
    };
  }

  // Rebuild the message array from the append-only event log via round grouping.
  const events = readEvents(session.id);
  const messages: any[] = [];
  for (const r of groupRounds(events)) {
    if (r.assistantText) messages.push({ role: "assistant", content: [{ type: "text", text: r.assistantText }] });
    for (const u of r.toolUses) messages.push({ role: "assistant", content: [{ type: "tool_use", id: u.id, name: u.name, input: u.input }] });
    for (const res of r.toolResults) {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: res.toolUseId, content: res.content }] });
    }
  }

  await repl(session, messages, initialPrompt);
  await closeScratchPage();
  process.stderr.write(`[session ${session.id} saved]\n`);
}

main().catch(async (e) => {
  console.error(e);
  await closeScratchPage();
  process.exit(1);
});
