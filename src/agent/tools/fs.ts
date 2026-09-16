import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "./index.js";
import { rejectUnresolvedPayloads, guarded } from "./index.js";

function abs(p: string, ctx?: ToolContext): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx?.cwd ?? process.cwd(), p);
}

function splitLines(raw: string): string[] {
  const lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** verify-on-disk: appended to every write/edit result in the SAME tool result,
 *  so truncation/corruption is caught without an extra 8-30s round trip. */
function verify(p: string, expected: string): string {
  const back = readFileSync(p, "utf8");
  const lines = splitLines(back).length;
  const match = back === expected;
  return ` [verified: ${back.length}B ${lines}L on disk, match=${match ? "yes" : "NO - re-read before continuing"}]`;
}

export const read: Tool = {
  name: "Read",
  description:
    "Read a file with line numbers. Params: file_path, offset (1-based line), limit (default 150). Header shows 'of TOTAL' - page with offset. Note the line numbers: Edit accepts start_line/end_line.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset: { type: "number", description: "1-based start line" },
      limit: { type: "number", description: "max lines (default 400)" },
    },
    required: ["file_path"],
  },
  run: async (input, ctx) => {
    try {
      const p = abs(input.file_path, ctx);
      const raw = readFileSync(p, "utf8");
      const lines = splitLines(raw);
      const total = lines.length;
      const start = Math.max(1, Math.floor(Number(input.offset) || 1));
      const limit = Math.min(400, Math.max(1, Math.floor(Number(input.limit) || 150)));
      const end = Math.min(total, start - 1 + limit);
      const numbered = lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(5)}\t${l}`)
        .join("\n");
      if (ctx?.readFiles) ctx.readFiles.add(p);
      const more = end < total ? `\n[... lines ${end + 1}-${total} not shown - Read again with offset=${end + 1}]` : "";
      return `${p}: lines ${start}-${end} of ${total} (${raw.length} bytes)\n${numbered}${more || "\n[end of file]"}`;
    } catch (e: any) {
      return `[error] ${e.message}`;
    }
  },
};

export const write: Tool = guarded({
  name: "Write",
  description:
    'Create/overwrite a file. Params: file_path, content. Overwriting an existing file requires Read first (guard). For content >~300 chars use the payload form: content="@payload:content" + raw @@TABLM t1 content <<\'EOF\' block.',
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" }, content: { type: "string" } },
    required: ["file_path", "content"],
  },
  validate: (input) => rejectUnresolvedPayloads(input),
  run: async (input, ctx) => {
    const p = abs(input.file_path, ctx);
    if (existsSync(p) && statSync(p).size > 0 && !ctx?.readFiles?.has(p)) {
      return `[refused] ${p} already exists (${statSync(p).size} bytes) and was not Read this session - overwriting would destroy unknown content. Read it first, then Write the complete new content.`;
    }
    try {
      writeFileSync(p, input.content);
      return `wrote ${input.content.length} chars to ${p}${verify(p, input.content)}`;
    } catch (e: any) {
      return `[error] ${e.message}`;
    }
  },
});

export const edit: Tool = guarded({
  name: "Edit",
  description:
    "Edit a file, two modes. A) text: old_string + new_string - must match exactly once (whitespace-tolerant fallback). B) lines: start_line + end_line + new_string replaces that inclusive range (end_line < start_line = pure insert before start_line). Large new_string: use the @payload form.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string", description: "mode A: exact text to replace, unique" },
      new_string: { type: "string", description: "replacement text (both modes)" },
      start_line: { type: "number", description: "mode B: first line (1-based, from Read)" },
      end_line: { type: "number", description: "mode B: last line inclusive; < start_line = insert" },
    },
    required: ["file_path", "new_string"],
  },
  validate: (input) => rejectUnresolvedPayloads(input),
  run: async (input, ctx) => {
    const p = abs(input.file_path, ctx);
    try {
      const raw = readFileSync(p, "utf8");
      const lines = splitLines(raw);
      const trailingNl = raw.endsWith("\n");

      // ---- mode B: line-range ----
      if (input.start_line != null) {
        const s = Math.max(1, Math.floor(Number(input.start_line)));
        const e = input.end_line != null ? Math.floor(Number(input.end_line)) : s;
        if (e >= s && e > lines.length) return `[error] end_line ${e} beyond end of file (${lines.length} lines)`;
        const ins = String(input.new_string ?? "").split("\n");
        if (e >= s) lines.splice(s - 1, e - s + 1, ...ins);
        else lines.splice(s - 1, 0, ...ins); // pure insert before line s
        const out = lines.join("\n") + (trailingNl ? "\n" : "");
        writeFileSync(p, out);
        return `edited ${p} lines ${s}-${e}${verify(p, out)}`;
      }

      // ---- mode A: text replace ----
      if (typeof input.old_string !== "string") return "[error] provide old_string (mode A) or start_line (mode B)";
      const count = raw.split(input.old_string).length - 1;
      if (count === 1) {
        const out = raw.replace(input.old_string, input.new_string);
        writeFileSync(p, out);
        return `edited ${p}${verify(p, out)}`;
      }

      // whitespace-tolerant fallback: line-anchored normalized match
      const norm = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
      const target = norm(input.old_string);
      const n = input.old_string.split("\n").length;
      const hits: number[] = [];
      for (let i = 0; i + n <= lines.length; i++) {
        if (norm(lines.slice(i, i + n).join("\n")) === target) hits.push(i);
      }
      if (hits.length === 1) {
        lines.splice(hits[0], n, ...String(input.new_string).split("\n"));
        const out = lines.join("\n") + (trailingNl ? "\n" : "");
        writeFileSync(p, out);
        return `edited ${p} (whitespace normalized around lines ${hits[0] + 1}-${hits[0] + n})${verify(p, out)}`;
      }

      // failure that TEACHES: point the model at the nearest real lines
      const firstLine = norm(input.old_string.split("\n")[0]).slice(0, 60);
      const tokens = (input.old_string.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []).slice(0, 3);
      const near: number[] = [];
      lines.forEach((l, i) => {
        if (near.length >= 5) return;
        if (norm(l).includes(firstLine) || tokens.some((tk: string) => l.includes(tk))) near.push(i + 1);
      });
      const hint = near.length
        ? `Lines containing similar text: ${near.join(", ")} - Read around them, then retry with the exact text or start_line/end_line.`
        : `No similar text found in ${lines.length} lines - maybe the wrong file, or Read it first.`;
      return count === 0
        ? `[error] old_string not found. ${hint}`
        : `[error] old_string found ${count} times - add surrounding lines to make it unique. ${hint}`;
    } catch (e: any) {
      return `[error] ${e.message}`;
    }
  },
});
