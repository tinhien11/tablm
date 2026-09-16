import assert from "node:assert/strict";
process.env.TABLM_COMPACT_THRESHOLD_CHARS = "50000";
const { groupRounds, deriveMessages, totalChars } = await import("../dist/agent/rounds.js");

const at = "";
const ev = (o) => Object.assign({ at }, o);
let pass = 0;
const fail = [];
function t(name, fn) {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail.push({ name, msg: e.message }); console.log("  FAIL " + name + " :: " + e.message); }
}

console.log("== agent/rounds deriveMessages (single projection) ==");

t("canonical projection: user -> assistant(text+tools) -> results -> final text", () => {
  const events = [
    ev({ type: "user", text: "do it" }),
    ev({ type: "assistant_text", text: "reading" }),
    ev({ type: "tool_use", id: "u1", name: "Read", input: { file_path: "f" } }),
    ev({ type: "tool_result", toolUseId: "u1", content: "contents" }),
    ev({ type: "assistant_text", text: "all done" }),
  ];
  const m = deriveMessages(events);
  assert.equal(m.length, 4);
  assert.deepEqual(m[0], { role: "user", content: "do it" });
  assert.equal(m[1].role, "assistant");
  assert.deepEqual(m[1].content, [
    { type: "text", text: "reading" },
    { type: "tool_use", id: "u1", name: "Read", input: { file_path: "f" } },
  ]);
  assert.deepEqual(m[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "contents" }] });
  assert.equal(m[3].role, "assistant");
  assert.deepEqual(m[3].content, [{ type: "text", text: "all done" }]);
});

t("attempt events are never model-visible", () => {
  const events = [
    ev({ type: "user", text: "go" }),
    ev({ type: "attempt", status: "error", detail: "gateway 500" }),
    ev({ type: "assistant_text", text: "done" }),
  ];
  const m = deriveMessages(events);
  assert.equal(m.length, 2);
  assert.ok(!JSON.stringify(m).includes("gateway 500"), "attempt detail must not leak");
});

t("compact event resets history, kept tail rebuilds after it", () => {
  const events = [
    ev({ type: "user", text: "old task" }),
    ev({ type: "assistant_text", text: "old work" }),
    ev({ type: "compact", summary: "[compacted summary]" }),
    ev({ type: "user", text: "old task" }),
    ev({ type: "assistant_text", text: "kept work" }),
    ev({ type: "tool_use", id: "k1", name: "Bash", input: { command: "ls" } }),
    ev({ type: "tool_result", toolUseId: "k1", content: "out" }),
  ];
  const m = deriveMessages(events);
  assert.deepEqual(m[0], { role: "user", content: "[compacted summary]" });
  assert.equal(m.length, 4, "summary + kept user + kept assistant(round) + result");
  assert.ok(!JSON.stringify(m).includes("old work"), "pre-compact history gone");
  assert.ok(JSON.stringify(m).includes("kept work"), "kept tail present");
});

t("derive idempotent: deriving the projected events shape stays stable", () => {
  const events = [
    ev({ type: "user", text: "t" }),
    ev({ type: "assistant_text", text: "a" }),
    ev({ type: "tool_use", id: "x", name: "Bash", input: {} }),
    ev({ type: "tool_result", toolUseId: "x", content: "c" }),
  ];
  const first = deriveMessages(events);
  // simulate the loop's messages->events->messages round trip
  const rederived = deriveMessages(
    first.flatMap((msg) =>
      msg.role === "assistant" && Array.isArray(msg.content)
        ? msg.content.map((b) =>
            b.type === "text" ? ev({ type: "assistant_text", text: b.text }) : ev({ type: "tool_use", id: b.id, name: b.name, input: b.input })
          )
        : Array.isArray(msg.content)
          ? msg.content.map((b) => ev({ type: "tool_result", toolUseId: b.tool_use_id, content: b.content }))
          : [ev({ type: "user", text: String(msg.content) })]
    )
  );
  assert.deepEqual(rederived, first);
});

console.log(`\n${fail.length === 0 ? "ALL PASS" : `${fail.length} FAILED`} (${pass} passed)`);
if (fail.length) { for (const f of fail) console.log("  FAILED: " + f.name + " :: " + f.msg); process.exit(1); }
