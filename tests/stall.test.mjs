// The stall classifiers decide "final answer vs keep pushing". Pure functions
// exported from loop.ts - tested directly.
import assert from "node:assert/strict";
const loop = await import("../dist/agent/loop.js");
const { isPlanning, isWaitingForUser } = loop;

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

console.log("== agent/loop stall patterns ==");

t("'No further action is pending... just let me know' = waiting (the PR-review stall)", () => {
  const text =
    "No further action is pending. I can post a verification-checklist comment to the PR thread or convert the review to APPROVE once the author confirms the build/tests pass — just let me know.";
  assert.equal(isWaitingForUser(text), true, "must be classified as waiting for user");
});

t("'shall I / want me to / should I' variants = waiting", () => {
  for (const s of [
    "Shall I post the comment now?",
    "Do you want me to run the tests?",
    "Should I convert this to APPROVE?",
    "Let me know if you need anything else.",
  ]) {
    assert.equal(isWaitingForUser(s), true, `waiting: ${s}`);
  }
});

t("genuine final answers are NOT waiting and NOT planning", () => {
  for (const s of [
    "The file has been written successfully with 12 lines. Task complete.",
    "Created the PR and posted the review comment. All checks pass.",
    "The version is 0.1.0 (from package.json).",
  ]) {
    assert.equal(isWaitingForUser(s), false, `not waiting: ${s}`);
    assert.equal(isPlanning(s), false, `not planning: ${s}`);
  }
});

t("'Batch 1 - core logic' Vietnamese narration = planning", () => {
  const text =
    "Bắt đầu phase review đầy đủ: đọc hết toàn bộ source. Batch 1 — core logic (protocol + gateway + agent):";
  assert.equal(isPlanning(text), true);
});

t("'I have most of the picture now' = planning", () => {
  assert.equal(isPlanning("I have most of the picture now. Let me read the remaining core files."), true);
});

t("completion markers are NEVER nudged", () => {
  for (const s of [
    "DONE - refactored all three modules, tests pass.",
    "Refactor hoàn thành. README đã cập nhật.",
    "Task complete: 12 fences restored, package.json valid.",
  ]) {
    assert.equal(isPlanning(s), false, `completion not planning: ${s}`);
    assert.equal(isWaitingForUser(s), false, `completion not waiting: ${s}`);
  }
});

console.log(`\n${fail.length === 0 ? "ALL PASS" : `${fail.length} FAILED`} (${pass} passed)`);
if (fail.length) {
  for (const f of fail) console.log("  FAILED: " + f.name + " :: " + f.msg);
  process.exit(1);
}
