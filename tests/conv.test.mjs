import assert from "node:assert/strict";

// conversation.ts keeps a module-level map keyed by the session key - each
// test uses a unique key so state never leaks between tests.

process.env.TABLM_CHAT_ROLLOVER_CHARS = "500"; // small for rollover tests
const { buildPrompt } = await import("../dist/gateway/conversation.js");

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

const msgs = (...texts) => texts.map((text) => ({ role: "user", content: text }));
const body = (m) => ({ model: "web-zai", messages: m });

console.log("== gateway/conversation new-chat policy ==");

t("brand-new key: full mode, no conversation -> new chat", () => {
  const r = buildPrompt(body(msgs("task A")), "k1");
  assert.equal(r.mode, "full");
  assert.equal(r.hadConversation, false);
  assert.equal(r.rolloverDue, false);
  assert.equal(r.resync, false);
});

t("append-only history: delta, same chat", () => {
  buildPrompt(body(msgs("task B", "q1")), "k2");
  const r = buildPrompt(body(msgs("task B", "q1", "q2")), "k2");
  assert.equal(r.mode, "delta");
  assert.equal(r.hadConversation, true);
});

t("diverged history (compaction/resume): full but SAME chat, resync flag", () => {
  buildPrompt(body(msgs("old task that went on for a while", "more", "more still")), "k3");
  const r = buildPrompt(body(msgs("[compacted summary]", "recent")), "k3");
  assert.equal(r.mode, "full");
  assert.equal(r.hadConversation, true, "chat exists - must NOT start a new one");
  assert.equal(r.rolloverDue, false, "young chat - no rollover");
  assert.equal(r.resync, true, "paste marked as re-sync");
});

t("rollover: old chat past budget -> next request starts a fresh chat", () => {
  // threshold is 500 chars in this test run; check is against pasted BEFORE
  // the current request, so the turn that crosses the line still lands, and
  // the NEXT one gom (rolls over).
  buildPrompt(body(msgs("first message for rollover key")), "k4"); // pasted ~55
  const big = "x".repeat(600);
  const r2 = buildPrompt(body(msgs("first message for rollover key", big)), "k4");
  assert.equal(r2.mode, "delta", "the crossing turn still lands in the same chat");

  // pasted is now over budget: any next request rolls over
  const r3 = buildPrompt(body(msgs("first message for rollover key", big, "one more")), "k4");
  assert.equal(r3.mode, "full", "next request becomes a fresh-chat seed");
  assert.equal(r3.rolloverDue, true);
  assert.equal(r3.hadConversation, true);
  assert.equal(r3.resync, false);

  // diverged history after budget also rolls over (not a resync):
  // first cross the budget for k5, then diverge
  buildPrompt(body(msgs("seed for k5")), "k5");
  buildPrompt(body(msgs("seed for k5", "y".repeat(600))), "k5"); // crosses budget
  const r5 = buildPrompt(body(msgs("completely different", "y".repeat(600))), "k5");
  assert.equal(r5.mode, "full", "divergence after budget crossed = full");
  assert.equal(r5.rolloverDue, true, "...and it rolls over to a new chat");
  assert.equal(r5.resync, false);
});

console.log(`\n${fail.length === 0 ? "ALL PASS" : `${fail.length} FAILED`} (${pass} passed)`);
if (fail.length) {
  for (const f of fail) console.log("  FAILED: " + f.name + " :: " + f.msg);
  process.exit(1);
}
