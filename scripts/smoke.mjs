import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/index.js"], { cwd: new URL("..", import.meta.url).pathname });
let buf = "";
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
let failures = 0;

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});

function handle(msg) {
  if (msg.id === 1) {
    console.log("PASS init:", msg.result?.serverInfo?.name, msg.result?.serverInfo?.version);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  } else if (msg.id === 2) {
    const names = msg.result.tools.map((t) => t.name);
    const expected = ["ask", "list_sites", "inspect_dom", "screenshot"];
    const ok = expected.every((e) => names.includes(e));
    console.log(ok ? "PASS tools/list:" : "FAIL tools/list:", names.join(", "));
    if (!ok) failures++;
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sites", arguments: {} } });
  } else if (msg.id === 3) {
    const text = msg.result?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text);
    const ok = Array.isArray(parsed) && parsed.every((s) => "id" in s);
    console.log(ok ? "PASS list_sites:" : "FAIL list_sites:", text.slice(0, 200));
    if (!ok) failures++;
    send({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "ask", arguments: { site: "kimi", prompt: "ping", timeout_s: 10 } },
    });
  } else if (msg.id === 4) {
    const text = msg.result?.content?.[0]?.text ?? "";
    const ok = text.includes("[tablm]") || msg.result?.isError;
    console.log(ok ? "PASS ask (graceful):" : "FAIL ask:", text.slice(0, 200));
    if (!ok) failures++;
    console.log(failures === 0 ? "SMOKE OK" : `SMOKE FAILED (${failures})`);
    proc.kill();
    process.exit(failures === 0 ? 0 : 1);
  }
}

proc.stderr.on("data", (d) => console.error("STDERR:", d.toString()));
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
setTimeout(() => { console.error("SMOKE TIMEOUT"); proc.kill(); process.exit(1); }, 60000);
