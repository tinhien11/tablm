#!/usr/bin/env node
import { exec as execCb } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const GATEWAY = process.env.TABLM_GATEWAY_URL || "http://127.0.0.1:8788";
const AUTH_TOKEN = process.env.TABLM_AUTH_TOKEN || "tablm";
const MODEL = process.env.TABLM_MODEL || "web-zai";
const MAX_TURNS = Number(process.env.TABLM_MAX_TURNS || 50);

// ---------- Tools ----------
interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  run: (input: any) => Promise<string>;
}

const tools: Tool[] = [
  {
    name: "Bash",
    description: "Execute a shell command. Returns stdout+stderr. Use for any system operation.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    run: async (input) => {
      return new Promise((resolve) => {
        execCb(input.command, { maxBuffer: 1024 * 1024 * 10, timeout: 120000 }, (err, stdout, stderr) => {
          let out = "";
          if (stdout) out += stdout;
          if (stderr) out += (out ? "\n[stderr]\n" : "[stderr]\n") + stderr;
          if (err && !stdout && !stderr) out += `[error] ${err.message}`;
          resolve(out.slice(0, 20000) || "(no output)");
        });
      });
    },
  },
  {
    name: "Read",
    description: "Read a file. Returns full contents.",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    run: async (input) => {
      try {
        return readFileSync(input.file_path, "utf8").slice(0, 50000);
      } catch (e: any) {
        return `[error] ${e.message}`;
      }
    },
  },
  {
    name: "Write",
    description: "Write content to a file (creates or overwrites).",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] },
    run: async (input) => {
      try {
        writeFileSync(input.file_path, input.content);
        return `wrote ${input.content.length} chars to ${input.file_path}`;
      } catch (e: any) {
        return `[error] ${e.message}`;
      }
    },
  },
  {
    name: "Edit",
    description: "Replace old_string with new_string in a file. Must match exactly once.",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] },
    run: async (input) => {
      try {
        const content = readFileSync(input.file_path, "utf8");
        const count = content.split(input.old_string).length - 1;
        if (count === 0) return `[error] old_string not found`;
        if (count > 1) return `[error] old_string found ${count} times - must be unique`;
        const updated = content.replace(input.old_string, input.new_string);
        writeFileSync(input.file_path, updated);
        return `edited ${input.file_path}`;
      } catch (e: any) {
        return `[error] ${e.message}`;
      }
    },
  },
  {
    name: "Grep",
    description: "Search file contents with regex. Returns matching lines with file:line:content.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "directory or file to search" }, glob: { type: "string" } }, required: ["pattern"] },
    run: async (input) => {
      return new Promise((resolve) => {
        const globFlag = input.glob ? `--include='${input.glob}'` : "";
        const cmd = `rg -n -- '${input.pattern.replace(/'/g, "'\\''")}' ${globFlag} '${input.path || "."}' 2>/dev/null | head -100`;
        execCb(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
          resolve(stdout || "(no matches)");
        });
      });
    },
  },
  {
    name: "Glob",
    description: "Find files by glob pattern. Returns matching file paths.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    run: async (input) => {
      return new Promise((resolve) => {
        const cmd = `find '${input.path || "."}' -path '${input.pattern}' -type f 2>/dev/null | head -100`;
        execCb(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
          resolve(stdout || "(no files)");
        });
      });
    },
  },
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

// ---------- API (streaming) ----------
interface StreamResult {
  content: any[];
  stop_reason: string;
}

async function callGateway(messages: any[], useTools: boolean): Promise<StreamResult> {
  const body: any = {
    model: MODEL,
    max_tokens: 8192,
    messages,
    stream: true,
  };
  if (useTools) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
  const res = await fetch(`${GATEWAY}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": AUTH_TOKEN,
      authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`gateway ${res.status}: ${text}`);
  }

  const content: any[] = [];
  let stopReason = "end_turn";
  const blocks: Record<number, any> = {};
  let textStarted = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const eventLine = chunk.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(7).trim();
      let data: any;
      try { data = JSON.parse(dataLine.slice(5)); } catch { continue; }

      if (event === "content_block_start") {
        const cb = data.content_block;
        blocks[data.index] = { type: cb.type, text: "", thinking: "", name: cb.name, id: cb.id, input: "" };
        if (cb.type === "text" && !textStarted) {
          textStarted = true;
          process.stderr.write("[model] ");
        }
      } else if (event === "content_block_delta") {
        const b = blocks[data.index];
        if (!b) continue;
        const d = data.delta;
        if (d.type === "text_delta") {
          b.text += d.text;
          process.stderr.write(d.text);
        } else if (d.type === "thinking_delta") {
          b.thinking += d.thinking;
        } else if (d.type === "input_json_delta") {
          b.input += d.partial_json;
        }
      } else if (event === "content_block_stop") {
        const b = blocks[data.index];
        if (!b) continue;
        if (b.type === "text") {
          content.push({ type: "text", text: b.text });
          process.stderr.write("\n");
        } else if (b.type === "tool_use") {
          let input: any = {};
          try { input = JSON.parse(b.input || "{}"); } catch {}
          content.push({ type: "tool_use", id: b.id, name: b.name, input });
          process.stderr.write(`\n[tool_use ${b.name}]\n`);
        } else if (b.type === "thinking") {
          content.push({ type: "thinking", thinking: b.thinking, signature: "tablm" });
        }
      } else if (event === "message_delta") {
        if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      }
    }
  }

  return { content, stop_reason: stopReason };
}

// ---------- Main loop ----------
async function runTurn(messages: any[]): Promise<boolean> {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    process.stderr.write(`\n--- turn ${turn + 1} ---\n`);
    let response: StreamResult;
    try {
      response = await callGateway(messages, true);
    } catch (e: any) {
      console.error(`gateway error: ${e.message}`);
      return false;
    }

    const content: any[] = response.content;

    // Collect tool_use blocks (text already printed during stream)
    const toolUses = content.filter((b: any) => b.type === "tool_use");
    if (toolUses.length === 0) {
      // No tools called - print final text to stdout and exit turn
      const text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      console.log(text);
      return true;
    }

    // Add assistant message
    messages.push({ role: "assistant", content });

    // Execute tools
    for (const tu of toolUses) {
      const tool = toolMap.get(tu.name);
      let result: string;
      if (!tool) {
        result = `[error] unknown tool: ${tu.name}`;
      } else {
        process.stderr.write(`[run] ${tu.name} ${JSON.stringify(tu.input).slice(0, 200)}\n`);
        try {
          result = await tool.run(tu.input);
        } catch (e: any) {
          result = `[error] ${e.message}`;
        }
      }
      process.stderr.write(`[result] ${result.slice(0, 300)}\n`);
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: tu.id, content: result }],
      });
    }
  }
  console.error(`reached max turns (${MAX_TURNS})`);
  return false;
}

async function main() {
  const initialPrompt = process.argv.slice(2).join(" ");
  if (!initialPrompt) {
    console.error("usage: tablm-cli <prompt>  (then interactive mode after)");
    process.exit(1);
  }

  const systemPrompt = `You are an autonomous coding agent. You have tools: Bash, Read, Write, Edit, Grep, Glob.

CRITICAL RULES:
1. DO NOT describe what you will do. DO NOT explain your plan. Just call the tool directly.
2. No preamble, no "I will now...", no "Let me...". Call the tool IMMEDIATELY.
3. If a task needs multiple steps, call tools for ALL steps in ONE response (multiple tool_use blocks).
4. Only output text when you have the FINAL answer (after all tools executed).
5. Work in ${process.cwd()}.
6. When the task is complete, output only "DONE" + brief summary.`;

  const messages: any[] = [{ role: "user", content: initialPrompt }];

  // Run initial prompt
  await runTurn(messages);

  // Interactive REPL: keep same session, accept follow-up prompts
  process.stderr.write(`\n=== session mode (cwd: ${process.cwd()}) - type follow-up or Ctrl-D to exit ===\n`);
  const readline = await import("node:readline/promises");
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
    messages.push({ role: "user", content: line });
    await runTurn(messages);
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
