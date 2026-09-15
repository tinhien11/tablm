import { exec as execCb } from "node:child_process";
import type { Tool } from "./index.js";
import { rejectUnresolvedPayloads, guarded } from "./index.js";

export const bash: Tool = guarded({
  name: "Bash",
  description: "Execute a shell command. Returns stdout+stderr. Use for any system operation.",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  validate: (input) => rejectUnresolvedPayloads(input),
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
});

export const grep: Tool = {
  name: "Grep",
  description: "Search file contents with regex. Returns matching lines with file:line:content.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "directory or file to search" },
      glob: { type: "string" },
    },
    required: ["pattern"],
  },
  run: async (input) => {
    return new Promise((resolve) => {
      const globFlag = input.glob ? `--include='${input.glob}'` : "";
      const cmd = `rg -n -- '${input.pattern.replace(/'/g, "'\\''")}' ${globFlag} '${input.path || "."}' 2>/dev/null | head -100`;
      execCb(cmd, { maxBuffer: 1024 * 1024 }, (_err, stdout) => {
        resolve(stdout || "(no matches)");
      });
    });
  },
};

export const glob: Tool = {
  name: "Glob",
  description: "Find files by glob pattern. Returns matching file paths.",
  input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
  run: async (input) => {
    return new Promise((resolve) => {
      const cmd = `find '${input.path || "."}' -path '${input.pattern}' -type f 2>/dev/null | head -100`;
      execCb(cmd, { maxBuffer: 1024 * 1024 }, (_err, stdout) => {
        resolve(stdout || "(no files)");
      });
    });
  },
};
