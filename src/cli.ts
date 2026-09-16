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
import { deriveMessages } from "./agent/rounds.js";

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
    console.log("  web-deepseek chat.deepseek.com");
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

  // model normalization + fail-fast: accept "web-chatgpt", "chatgpt",
  // "chatgpt-web" (any order), but NEVER silently route an unknown id to the
  // default site (that is how "chatgpt-web" ended up asking z.ai).
  const { siteIds } = await import("./transport/driver.js");
  const sites = siteIds();
  const bare = model.replace(/^web-/, "").replace(/-web$/, "");
  if (sites.includes(bare)) {
    model = `web-${bare}`;
  } else {
    console.error(`unknown model "${model}" - valid: ${sites.map((s) => "web-" + s).join(", ")}`);
    process.exit(1);
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

  // THE single projection: rebuild messages exactly as the live loop sees
  // them (same function the loop uses for its own context) - one mapper,
  // no drift between resume and live shapes.
  const messages = deriveMessages(readEvents(session.id));

  await repl(session, messages, initialPrompt);
  await closeScratchPage();
  process.stderr.write(`[session ${session.id} saved]\n`);
}

main().catch(async (e) => {
  console.error(e);
  await closeScratchPage();
  process.exit(1);
});
