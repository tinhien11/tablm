import assert from "node:assert/strict";
import { parseToolCalls, extractJsonObject } from "../dist/protocol/parse.js";
import {
  NARRATION_NO_TOOLS,
  PAYLOAD_MISSING,
  PAYLOAD_REF_ONLY,
  PAYLOAD_OK,
  PAYLOAD_WITH_INNER_FENCE,
  HEREDOC_IN_JSON,
  PAYLOAD_TRUNCATED,
  MULTI_CALL,
  JSON_FENCE_CALL,
  BARE_JSON_CALL,
} from "./fixtures.mjs";

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

console.log("== protocol/parse ==");

t("plain narration parses to zero calls, text preserved", () => {
  const r = parseToolCalls(NARRATION_NO_TOOLS);
  assert.equal(r.calls.length, 0);
  assert.equal(r.cleanText, NARRATION_NO_TOOLS);
});

t("payload ref with NO raw block is unresolved (fail-closed)", () => {
  const r = parseToolCalls(PAYLOAD_REF_ONLY);
  assert.equal(r.calls.length, 1, "must surface the call so repair can target it");
  assert.equal(r.calls[0].unresolved.length, 1, "content must NOT resolve");
  assert.equal(r.calls[0].unresolved[0], "content");
  // and the input must still be the raw marker, never substituted
  assert.equal(r.calls[0].input.content, "@payload:content");
});

t("payload missing in a fence is unresolved", () => {
  const r = parseToolCalls(PAYLOAD_MISSING);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].unresolved[0], "content");
});

t("well-formed payload resolves verbatim", () => {
  const r = parseToolCalls(PAYLOAD_OK);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].unresolved.length, 0);
  assert.ok(r.calls[0].input.content.includes("Line with \"quotes\" and {braces}"));
  assert.ok(r.calls[0].input.content.includes("A ``` fence inside the payload"));
});

t("inner ``` fence inside payload does not start a second call", () => {
  const r = parseToolCalls(PAYLOAD_WITH_INNER_FENCE);
  assert.equal(r.calls.length, 1, "inner fence must not be re-matched");
  assert.ok(r.calls[0].input.content.includes("console.log"));
});

t("heredoc-in-JSON (escaped newlines) still parses", () => {
  const r = parseToolCalls(HEREDOC_IN_JSON);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "Bash");
  assert.ok(r.calls[0].input.command.includes("cat > README.md"));
});

t("truncated payload is reported, call stays unresolved", () => {
  const r = parseToolCalls(PAYLOAD_TRUNCATED);
  assert.equal(r.truncated.length, 1, "truncated payload must be flagged for continuation repair");
  assert.equal(r.truncated[0].key, "content");
  assert.equal(r.calls[0].unresolved[0], "content");
});

t("multiple tool calls in one response", () => {
  const r = parseToolCalls(MULTI_CALL);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].name, "Read");
  assert.equal(r.calls[1].name, "Grep");
});

t("ChatGPT-style ```json fence parses", () => {
  const r = parseToolCalls(JSON_FENCE_CALL);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "Bash");
});

t("bare JSON (backticks stripped) parses", () => {
  const r = parseToolCalls(BARE_JSON_CALL);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "Bash");
});

t("cleanText strips the tool block, keeps prose before it", () => {
  const r = parseToolCalls("Here is prose.\n\n" + BARE_JSON_CALL);
  assert.equal(r.cleanText, "Here is prose.");
});

t("extractJsonObject handles nested braces and escapes", () => {
  const obj = extractJsonObject('prefix {"a":"b}c", "n":{"x":1}} tail', 0);
  assert.equal(obj, '{"a":"b}c", "n":{"x":1}}');
});

t("extractJsonObject returns null when truncated", () => {
  assert.equal(extractJsonObject('{"a":"b"', 0), null);
});

console.log(`\n${fail.length === 0 ? "ALL PASS" : `${fail.length} FAILED`} (${pass} passed)`);
if (fail.length) {
  for (const f of fail) console.log("  FAILED: " + f.name + " :: " + f.msg);
  process.exit(1);
}
