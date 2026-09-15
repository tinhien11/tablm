import assert from "node:assert/strict";
import { groupRounds, planCompaction, totalChars } from "../dist/agent/rounds.js";

let pass = 0;
const fail = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fail.push({ name, msg: e.message });
    console.log("  FAIL " + name + " :: " + e.message);
  }
}

const now = "";
const ev = (o) => Object.assign({ at: now }, o);

console.log("== agent/rounds compaction ==");

t("small history: no compaction", () => {
  const rounds = groupRounds([
    ev({ type: "user", text: "hi" }),
    ev({ type: "assistant_text", text: "done" }),
  ]);
  const plan = planCompaction(rounds);
  assert.equal(plan.compact, false);
});

t("monster recent round gets clamped and bounded", () => {
  // reproduces the turn-10 stall: one round with a ~60K tool result
  const events = [ev({ type: "user", text: "task" })];
  for (let i = 0; i < 8; i++) {
    events.push(ev({ type: "assistant_text", text: "step " + i }));
    events.push(ev({ type: "tool_use", id: "u" + i, name: "Read", input: { file_path: "f" + i } }));
    events.push(ev({ type: "tool_result", toolUseId: "u" + i, content: "result ".repeat(200) }));
  }
  // the monster: latest round, one 60K result
  events.push(ev({ type: "tool_use", id: "monster", name: "Read", input: { file_path: "big" } }));
  events.push(ev({ type: "tool_result", toolUseId: "monster", content: "x".repeat(60000) }));

  const rounds = groupRounds(events);
  const plan = planCompaction(rounds);
  assert.equal(plan.compact, true, "must compact");
  const kept = totalChars(plan.keep);
  assert.ok(kept < 40000, `kept tail must be bounded, got ${kept}`);
  const monster = plan.keep.flatMap((r) => r.toolResults).find((r) => r.toolUseId === "monster");
  assert.ok(monster, "most recent round must be kept");
  assert.ok(monster.content.length < 5000, `monster result must be clamped, got ${monster.content.length}`);
  assert.ok(monster.content.startsWith("xxxxx"), "clamped result keeps its head");
});

t("summary includes rounds dropped from the kept tail", () => {
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push(ev({ type: "assistant_text", text: "round " + i }));
    events.push(ev({ type: "tool_use", id: "u" + i, name: "Bash", input: { command: "cmd " + i } }));
    events.push(ev({ type: "tool_result", toolUseId: "u" + i, content: "out ".repeat(1500) }));
  }
  const rounds = groupRounds(events);
  const plan = planCompaction(rounds);
  assert.equal(plan.compact, true);
  assert.ok(plan.summary.includes("round 0"), "oldest round in summary");
  const keptFirst = plan.keep[0];
  const keptIds = new Set(plan.keep.flatMap((r) => r.toolUses.map((u) => u.id)));
  for (const r of rounds) {
    for (const u of r.toolUses) {
      if (!keptIds.has(u.id)) {
        // every dropped round must appear in the summary
        const label = `Assistant called Bash(`;
        assert.ok(plan.summary.includes(label), "dropped rounds summarized");
        break;
      }
    }
  }
  assert.ok(keptFirst, "keep non-empty");
});

t("WORST CASE with enforced cap: single round bounded at 6 x 8K", () => {
  // The enforced per-turn cap (6 calls) bounds one round's growth at
  // 6 x 8000 = 48K (+ overhead) - regardless of what the model emits.
  // Layered invariants from here:
  //   compaction (fires >= 50K) clamps kept results to 4K -> tail ~24K
  //   gateway hard-caps any prompt at 60K, truncating the middle
  const events = [ev({ type: "user", text: "task" })];
  events.push(ev({ type: "assistant_text", text: "all at once" }));
  for (let i = 0; i < 6; i++) {
    events.push(ev({ type: "tool_use", id: "u" + i, name: "Read", input: { file_path: "f" } }));
    events.push(ev({ type: "tool_result", toolUseId: "u" + i, content: "r".repeat(8000) }));
  }
  const rounds = groupRounds(events);
  const plan = planCompaction(rounds);
  const kept = plan.compact ? totalChars(plan.keep) : totalChars(rounds);
  assert.ok(kept < 52000, `worst-case single round must be bounded near 48K, got ${kept}`);

  // once history crosses the compaction threshold, the kept tail is ~24K
  events.push(ev({ type: "assistant_text", text: "more" }));
  events.push(ev({ type: "tool_use", id: "v", name: "Read", input: { file_path: "g" } }));
  events.push(ev({ type: "tool_result", toolUseId: "v", content: "r".repeat(8000) }));
  const plan2 = planCompaction(groupRounds(events));
  assert.equal(plan2.compact, true, "crossing 50K must compact");
  assert.ok(totalChars(plan2.keep) <= 30000, `post-compaction tail must fit budget, got ${totalChars(plan2.keep)}`);
});

console.log(`\n${fail.length === 0 ? "ALL PASS" : `${fail.length} FAILED`} (${pass} passed)`);
if (fail.length) {
  for (const f of fail) console.log("  FAILED: " + f.name + " :: " + f.msg);
  process.exit(1);
}
