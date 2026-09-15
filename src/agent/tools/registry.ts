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

export const TOOLS: Tool[] = [
  bash,
  read,
  write,
  edit,
  grep,
  glob,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserFill,
  browserScreenshot,
  browserEval,
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

export { closeScratchPage } from "./browser.js";
