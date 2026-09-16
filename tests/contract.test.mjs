import assert from "node:assert/strict";
const c = await import("../dist/protocol/contract.js");
const { agentPreamble, siteAdvisory, toolProtocol, contextHead, PROTOCOL_VERSION } = c;

let pass = 0;
const fail = [];
function t(name, fn) {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail.push({ name, msg: e.message }); console.log("  FAIL " + name + " :: " + e.message); }
}

console.log("== protocol/contract site split ==");

t("preamble is universal English brain-framing", () => {
  const p = agentPreamble();
  assert.ok(p.includes("DIFFERENT machine"));
  assert.ok(p.includes("tooluse block"));
  assert.ok(!p.includes("chatgpt"), "no site name in universal preamble");
});

t("chatgpt gets the sandbox advisory; zai/kimi get NOTHING", () => {
  assert.ok(siteAdvisory("chatgpt").includes("sandbox"), "chatgpt advisory present");
  assert.ok(siteAdvisory("chatgpt").includes("command not found"));
  assert.equal(siteAdvisory("zai"), "", "zai must stay clean");
  assert.equal(siteAdvisory("kimi"), "", "kimi must stay clean");
  assert.equal(siteAdvisory("unknown-site"), "", "unknown site: no advisory");
});

t("contextHead embeds advisory only for the matching site", () => {
  assert.ok(contextHead("chatgpt").includes("SITE-SPECIFIC WARNING"), "chatgpt advisory");
  assert.ok(!contextHead("zai").includes("SITE-SPECIFIC"), "zai stays clean");
  assert.ok(contextHead("zai").startsWith("[Agent context]"), "zai still gets the universal head");
});

t("contextHead lands at the very start for chatgpt", () => {
  const h = contextHead("chatgpt");
  assert.ok(h.startsWith("[Agent context]"), "starts with preamble");
  assert.ok(h.includes("SITE-SPECIFIC WARNING"));
});

t("v8: PROOF receipt + transcription reframe still present", () => {
  const p = toolProtocol([{ name: "Bash" }]);
  assert.ok(p.includes("PROOF THE LOOP IS REAL"));
  assert.ok(p.includes("TRANSCRIPTION"));
  assert.ok(p.includes("NEVER run commands with your own"));
});

t("receipt in protocol does not leak @TBF@ garbage; version is v8", () => {
  const p = toolProtocol([{ name: "Bash" }]);
  assert.ok(p.includes("v" + PROTOCOL_VERSION));
  assert.equal(PROTOCOL_VERSION, 8);
});

console.log(`\n${fail.length === 0 ? "ALL PASS" : `${fail.length} FAILED`} (${pass} passed)`);
if (fail.length) { for (const f of fail) console.log("  FAILED: " + f.name + " :: " + f.msg); process.exit(1); }
