import { readFileSync, writeFileSync } from "node:fs";
import type { Tool } from "./index.js";
import { rejectUnresolvedPayloads, guarded } from "./index.js";

export const read: Tool = {
  name: "Read",
  description: "Read a file. Returns full contents (truncated to 50000 chars).",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  run: async (input) => {
    try {
      return readFileSync(input.file_path, "utf8").slice(0, 50000);
    } catch (e: any) {
      return `[error] ${e.message}`;
    }
  },
};

export const write: Tool = guarded({
  name: "Write",
  description:
    'Write content to a file. For content over ~300 chars, use the payload form: set content to "@payload:content" and output the raw text between @@TABLM t1 content <<\'EOF\' and @@TABLM_END t1 after the JSON (no escaping needed).',
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" }, content: { type: "string" } },
    required: ["file_path", "content"],
  },
  validate: (input) => rejectUnresolvedPayloads(input),
  run: async (input) => {
    try {
      writeFileSync(input.file_path, input.content);
      return `wrote ${input.content.length} chars to ${input.file_path}`;
    } catch (e: any) {
      return `[error] ${e.message}`;
    }
  },
});

export const edit: Tool = guarded({
  name: "Edit",
  description: "Replace old_string with new_string in a file. Must match exactly once.",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
    required: ["file_path", "old_string", "new_string"],
  },
  validate: (input) => rejectUnresolvedPayloads(input),
  run: async (input) => {
    try {
      const content = readFileSync(input.file_path, "utf8");
      const count = content.split(input.old_string).length - 1;
      if (count === 0) return `[error] old_string not found`;
      if (count > 1) return `[error] old_string found ${count} times - must be unique`;
      writeFileSync(input.file_path, content.replace(input.old_string, input.new_string));
      return `edited ${input.file_path}`;
    } catch (e: any) {
      return `[error] ${e.message}`;
    }
  },
});
