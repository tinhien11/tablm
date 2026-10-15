// Machine skill discovery for the agent layers.
//
// The user keeps prompt-playbooks at <home>/{.agents,.zcode,.claude}/skills/
// <name>/SKILL.md (YAML frontmatter with name/description). Both agent layers
// consume this module:
//   - gateway head-of-context: a compact index so text-protocol models know
//     the playbooks exist and can Read them with their tools
//   - MCP server: list_skills / read_skill tools for native clients (chatgpt)
//
// Disabled with TABLM_SKILLS=0. Extra dirs: TABLM_SKILL_DIRS="path1:path2".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SkillEntry {
  name: string;
  file: string;
  description: string;
}

function skillDirs(): string[] {
  if (process.env.TABLM_SKILLS === "0") return [];
  const raw =
    process.env.TABLM_SKILL_DIRS ||
    [".agents/skills", ".zcode/skills", ".claude/skills"]
      .map((d) => path.join(os.homedir(), d))
      .join(":");
  return raw.split(":").filter(Boolean);
}

function extractDescription(raw: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (fm) {
    const m = /^description:\s*['"]?(.+?)['"]?\s*$/m.exec(fm[1]);
    if (m) return m[1].trim().slice(0, 180);
  }
  const line = raw
    .split("\n")
    .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
  return (line ?? "").trim().slice(0, 180);
}

export function listSkills(): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const dir of skillDirs()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = path.join(dir, name, "SKILL.md");
      try {
        const raw = fs.readFileSync(file, "utf8");
        out.push({ name, file, description: extractDescription(raw) });
      } catch {}
    }
  }
  return out;
}

export function readSkillFile(name: string): string | null {
  for (const dir of skillDirs()) {
    const file = path.join(dir, name, "SKILL.md");
    try {
      return fs.readFileSync(file, "utf8");
    } catch {}
  }
  return null;
}

/** Compact head-of-context block. Empty string when disabled/no skills. */
export function skillsIndexText(): string {
  const skills = listSkills();
  if (!skills.length) return "";
  const lines = skills
    .slice(0, 40)
    .map((s) => `- ${s.name}: ${s.description} (playbook: ${s.file})`);
  return [
    "[Machine skills] The user's machine has these skill playbooks. When the task matches one, Read its playbook file first, then follow it with your other tools:",
    ...lines,
  ].join("\n");
}
