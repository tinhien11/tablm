import readline from "node:readline/promises";
import { runTurn } from "./loop.js";
import { appendEvent, saveMeta, type Session } from "./log.js";

export async function repl(session: Session, messages: any[], initialPrompt?: string): Promise<void> {
  // initial prompt (if any) runs as the first turn
  if (initialPrompt) {
    appendEvent(session.id, { type: "user", text: initialPrompt, at: new Date().toISOString() });
    messages.push({ role: "user", content: initialPrompt });
    await runTurn(session, messages);
    saveMeta(session);
    appendEvent(session.id, {
      type: "assistant_text",
      text: "(turn complete)",
      at: new Date().toISOString(),
    });
  }

  process.stderr.write(
    `\n=== session ${session.id} (cwd: ${session.cwd}) - type a task or follow-up, Ctrl-D to exit ===\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  while (true) {
    let line: string;
    try {
      line = await rl.question("> ");
    } catch {
      break;
    }
    if (line === null) break; // Ctrl-D
    line = line.trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") break;
    if (!session.prompt) session.prompt = line; // first input becomes the session title
    appendEvent(session.id, { type: "user", text: line, at: new Date().toISOString() });
    messages.push({ role: "user", content: line });
    await runTurn(session, messages);
    saveMeta(session);
  }
  rl.close();
  saveMeta(session);
}
