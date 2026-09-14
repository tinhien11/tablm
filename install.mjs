#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const root = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const dist = path.join(root, "dist");
const binDir = isWin ? path.join(home, ".tablm", "bin") : path.join(home, ".local", "bin");
const cfgDir = path.join(home, ".web2model");
const logFile = path.join(cfgDir, "gateway.log");

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, shell: isWin });
  if (r.status !== 0) {
    console.error(`command failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function writeLauncher(name, body) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, isWin ? name + ".cmd" : name);
  fs.writeFileSync(file, body);
  if (!isWin) fs.chmodSync(file, 0o755);
  return file;
}

function gatewayBody() {
  const gw = path.join(dist, "gateway.js");
  const nodeBin = process.execPath;
  return isWin
    ? `@echo off\nif not exist "${cfgDir}" mkdir "${cfgDir}"\n"${nodeBin}" "${gw}" %* >> "${logFile}" 2>&1\n`
    : `#!/usr/bin/env bash\nmkdir -p "${cfgDir}"\nexport PATH="${path.dirname(process.execPath)}:$PATH"\nexec "${nodeBin}" "${gw}" "$@" >> "${logFile}" 2>&1\n`;
}

function claudeBody() {
  const nodeBinDir = path.dirname(process.execPath);
  return isWin
    ? `@echo off\nset "ANTHROPIC_BASE_URL=http://127.0.0.1:8788"\nset "ANTHROPIC_AUTH_TOKEN=tablm"\nset "ANTHROPIC_MODEL=web-chatgpt"\nclaude %*\n`
    : `#!/usr/bin/env bash\nexport PATH="${nodeBinDir}:$PATH"\nexport ANTHROPIC_BASE_URL="\${ANTHROPIC_BASE_URL:-http://127.0.0.1:8788}"\nexport ANTHROPIC_AUTH_TOKEN="\${ANTHROPIC_AUTH_TOKEN:-tablm}"\nexport ANTHROPIC_MODEL="\${ANTHROPIC_MODEL:-web-zai}"\nexec claude "$@"\n`;
}

function statusBody() {
  return isWin
    ? `@echo off\necho == gateway ==\ncurl -s --max-time 3 http://127.0.0.1:8788/health || echo gateway DOWN\necho.\necho == chrome (CDP :9222) ==\ncurl -s --max-time 3 http://127.0.0.1:9222/json/version >nul 2>&1 && echo up || echo not running (auto-launches on first ask)\n`
    : `#!/usr/bin/env bash\necho "== gateway =="\ncurl -s --max-time 3 http://127.0.0.1:8788/health || echo "gateway DOWN (start: tablm-gateway &)"\necho\necho "== chrome (CDP :9222) =="\ncurl -s --max-time 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && echo up || echo "not running (auto-launches on first ask)"\n`;
}

function logsBody() {
  return isWin
    ? `@echo off\nif not exist "${cfgDir}" mkdir "${cfgDir}"\ntail -n 50 -f "${logFile}"\n`
    : `#!/usr/bin/env bash\nmkdir -p "${cfgDir}"\ntail -n 50 -f "${logFile}"\n`;
}

console.log(`[1/6] npm install (${root})`);
sh("npm", ["install"]);

console.log("[2/6] Building");
sh("npm", ["run", "build"]);

console.log("[3/6] Registering MCP server with Claude Code");
if (spawnSync("claude", ["--version"], { shell: isWin }).status === 0) {
  spawnSync("claude", ["mcp", "remove", "tablm"], { shell: isWin, stdio: "ignore" });
  const add = spawnSync("claude", ["mcp", "add", "-s", "user", "tablm", "--", "node", path.join(dist, "index.js")], { shell: isWin, stdio: "inherit" });
  if (add.status !== 0) {
    spawnSync("claude", ["mcp", "add", "tablm", "--", "node", path.join(dist, "index.js")], { shell: isWin, stdio: "inherit" });
  }
  console.log(`  registered: tablm -> node ${path.join(dist, "index.js")}`);
} else {
  console.log("  claude CLI not found. Add manually later:");
  console.log(`    claude mcp add -s user tablm -- node ${path.join(dist, "index.js")}`);
}

console.log("[4/6] Installing launchers");
writeLauncher("tablm-gateway", gatewayBody());
writeLauncher("tablm", claudeBody());
writeLauncher("tablm-status", statusBody());
writeLauncher("tablm-logs", logsBody());
if (isWin) {
  const ps = `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";${binDir}", "User")`;
  const cur = process.env.PATH || "";
  if (!cur.toLowerCase().includes(binDir.toLowerCase())) {
    spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
  }
  console.log(`  launchers in ${binDir} (added to user PATH - open a NEW terminal)`);
} else {
  console.log(`  launchers in ${binDir}`);
}

console.log("[5/6] Autostart at login");
if (isWin) {
  const startup = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "tablm-gateway.cmd");
  fs.copyFileSync(path.join(binDir, "tablm-gateway.cmd"), startup);
  console.log(`  Startup folder: ${startup}`);
} else if (spawnSync("systemctl", ["--user", "status"], { stdio: "ignore" }).status === 0) {
  const sd = path.join(home, ".config", "systemd", "user");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(
    path.join(sd, "tablm-gateway.service"),
    `[Unit]\nDescription=tablm gateway\n[Service]\nExecStart=${path.join(binDir, "tablm-gateway")}\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=default.target\n`
  );
  spawnSync("systemctl", ["--user", "daemon-reload"]);
  spawnSync("systemctl", ["--user", "enable", "--now", "tablm-gateway.service"], { stdio: "ignore" });
  console.log("  systemd user service: tablm-gateway (enabled)");
} else {
  const ad = path.join(home, ".config", "autostart");
  fs.mkdirSync(ad, { recursive: true });
  fs.writeFileSync(
    path.join(ad, "tablm-gateway.desktop"),
    `[Desktop Entry]\nType=Application\nName=tablm Gateway\nExec=${path.join(binDir, "tablm-gateway")}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`
  );
  console.log("  .desktop autostart installed");
}

console.log("[6/6] Starting gateway");
let up = false;
try {
  const r = await fetch("http://127.0.0.1:8788/health", { signal: AbortSignal.timeout(2000) });
  up = r.ok;
} catch {}
if (up) {
  console.log("  already running on :8788");
} else {
  const child = spawn(process.execPath, [path.join(dist, "gateway.js")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r2 = await fetch("http://127.0.0.1:8788/health", { signal: AbortSignal.timeout(2000) });
      if (r2.ok) { up = true; break; }
    } catch {}
  }
  console.log(up ? "  running on :8788" : `  WARNING: not up yet - check ${logFile}`);
}

console.log(`
============================================================
 tablm installed. Next steps:

   1. Run:            ${isWin ? "tablm (open a NEW terminal)" : "tablm"}
      (a Chrome window opens on first use - sign in to
       chatgpt.com / chat.z.ai / kimi.ai once, cookies persist)

   2. Model ids:      web-chatgpt | web-zai | web-kimi
      switch with:    tablm --model web-zai

   Useful commands:
     tablm-status    gateway + Chrome health
     tablm-logs      tail the gateway log
     npm test        MCP smoke test (in ${root})

   The gateway autostarts at login.
============================================================`);
