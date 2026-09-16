import type { Tool } from "./index.js";
import { read, write, edit } from "./fs.js";
import { bash, grep, glob } from "./shell.js";
import {
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserFill,
  browserScreenshot,
  browserEval,
} from "./browser.js";

const FS_SHELL_TOOLS = [bash, read, write, edit, grep, glob];
const BROWSER_TOOLS = [
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserFill,
  browserScreenshot,
  browserEval,
];

/**
 * Tool profiles. The 12-tool protocol block is ~1.8K chars injected into EVERY
 * web prompt - "minimal" (local coding tasks) cuts that by half, which matters
 * when the model is a web chat with a soft instruction budget.
 *   TABLM_TOOLS=minimal  6 local tools (bash/read/write/edit/grep/glob)
 *   TABLM_TOOLS=full     all 12 (default)
 */
export function resolveTools(): Tool[] {
  const profile = (process.env.TABLM_TOOLS || "full").toLowerCase();
  if (profile === "minimal" || profile === "core") return FS_SHELL_TOOLS;
  return [...FS_SHELL_TOOLS, ...BROWSER_TOOLS];
}

export const TOOLS: Tool[] = resolveTools();

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

export { closeScratchPage } from "./browser.js";
