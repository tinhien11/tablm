import assert from "node:assert/strict";
import fs from "node:fs";
const { read, write, edit } = await import("../dist/agent/tools/fs.js");

const DIR = "/tmp/tablm-tools-test";
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const ctx = { cwd: DIR, readFiles: new Set() };
const P = DIR + "/sample.ts";

// deterministic fixture: 12 lines with distinct indentation
const content = ["import x from 'x';", "", "function main() {", "  const a = 1;", "  const b = 2;", "  if (a) {", "    work(a, b);", "  }", "}", "", "main();", ""].join("\n");
fs.writeFileSync(P, content);

let pass = 0;
const fail = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail.push({ name, msg: e.message }); console.log("  FAIL " + name + " :: " + e.message); }
}
const r = (tool, input) => tool.run(input, ctx);

console.log("== tools/fs accuracy ==");

await t("Read returns line numbers + total header", async () => {
  const out = await r(read, { file_path: P });
  assert.ok(out.includes(`lines 1-11 of 11 (${content.length} bytes)`), "header: " + out.slice(0, 90));
  assert.ok(out.includes("    4\t  const a = 1;"), "line numbers: " + out.split("\n")[4]);
});

await t("Read paging: offset/limit + remain hint", async () => {
  const out = await r(read, { file_path: P, offset: 4, limit: 3 });
  assert.ok(out.includes("lines 4-6 of 11"));
  assert.ok(out.includes("[... lines 7-11 not shown - Read again with offset=7]"));
});

await t("Write new file verifies on disk in the same result", async () => {
  const out = await r(write, { file_path: DIR + "/new.txt", content: "hello\nworld\n" });
  assert.ok(out.includes("match=yes"), out);
  assert.ok(out.includes("2L"), "line count in verify: " + out);
});

await t("Write overwrite WITHOUT prior Read is refused (accuracy guard)", async () => {
  const out = await r(write, { file_path: DIR + "/new.txt", content: "clobbered" });
  assert.ok(out.startsWith("[refused]"), "refused: " + out);
  assert.ok(out.includes("Read it first"));
  assert.equal(fs.readFileSync(DIR + "/new.txt", "utf8"), "hello\nworld\n", "content untouched");
});

await t("Write overwrite after Read is allowed", async () => {
  await r(read, { file_path: DIR + "/new.txt" });
  const out = await r(write, { file_path: DIR + "/new.txt", content: "replaced\n" });
  assert.ok(out.includes("match=yes"), out);
  assert.equal(fs.readFileSync(DIR + "/new.txt", "utf8"), "replaced\n");
});

await t("Edit exact match works", async () => {
  await r(read, { file_path: P });
  const out = await r(edit, { file_path: P, old_string: "  const a = 1;", new_string: "  const a = 42;" });
  assert.ok(out.includes("match=yes"), out);
  assert.ok(fs.readFileSync(P, "utf8").includes("const a = 42;"));
});

await t("Edit whitespace-tolerant fallback applies + reports normalization", async () => {
  await r(read, { file_path: P });
  // model remembers the line with WRONG indentation (4 spaces vs actual 2)
  const out = await r(edit, { file_path: P, old_string: "    const a = 42;", new_string: "    const a = 7;" });
  assert.ok(out.includes("whitespace normalized"), out);
  assert.ok(fs.readFileSync(P, "utf8").includes("const a = 7;"), "applied");
});

await t("Edit not-found error teaches: nearest line numbers", async () => {
  await r(read, { file_path: P });
  const out = await r(edit, { file_path: P, old_string: "  work(9, 9);", new_string: "x" });
  assert.ok(out.startsWith("[error] old_string not found"), out);
  assert.ok(out.includes("Lines containing similar text"), out);
});

await t("Edit line-range mode replaces inclusive range", async () => {
  await r(read, { file_path: P });
  const out = await r(edit, { file_path: P, start_line: 6, end_line: 8, new_string: "  work(a, b);\n}" });
  assert.ok(out.includes("match=yes"), out);
  const t2 = fs.readFileSync(P, "utf8");
  assert.ok(t2.includes("  work(a, b);\n}") && !t2.includes("if (a)"), "range replaced");
});

await t("Edit insert mode (end_line < start_line)", async () => {
  const out = await r(edit, { file_path: P, start_line: 1, end_line: 0, new_string: "// inserted header" });
  assert.ok(out.includes("match=yes"), out);
  assert.equal(fs.readFileSync(P, "utf8").split("\n")[0], "// inserted header");
});

await t("unresolved @payload still refused (guard intact)", async () => {
  const out = await r(write, { file_path: DIR + "/x.txt", content: "@payload:content" });
  assert.ok(out.includes("refused"), out);
});

console.log(`\n${fail.length === 0 ? "ALL PASS" : `${fail.length} FAILED`} (${pass} passed)`);
if (fail.length) { for (const f of fail) console.log("  FAILED: " + f.name + " :: " + f.msg); process.exit(1); }
