// MCP (Model Context Protocol) remote endpoint for the gateway.
//
// Lets ChatGPT (Settings -> Connectors -> add https://<host>/mcp) call tablm
// tools NATIVELY - no text protocol, no sandbox competition. ChatGPT presses
// the button; this file executes it on the real machine and returns the text.
//
// Transport: MCP Streamable HTTP - JSON-RPC 2.0 messages POSTed to /mcp,
// responses as application/json (stateless: no session id, no SSE stream).
// Auth: Authorization: Bearer <TABLM_MCP_TOKEN> (generated + logged at startup
// when the env var is unset).

import { exec as execCb } from "node:child_process";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import fs from "node:fs";

// Token must be STABLE across restarts (ChatGPT's connector config holds it).
// Resolution: env TABLM_MCP_TOKEN > persisted ~/.tablm/mcp-token > generated+saved.
const TOKEN_FILE = path.join(os.homedir(), ".tablm", "mcp-token");

function loadOrCreateToken(): string {
  if (process.env.TABLM_MCP_TOKEN) return process.env.TABLM_MCP_TOKEN;
  try {
    const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  } catch {}
  const generated = crypto.randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, generated, { mode: 0o600 });
  } catch {}
  return generated;
}

export const MCP_TOKEN = loadOrCreateToken();
const MCP_CWD = process.env.TABLM_MCP_CWD || os.homedir();
const MCP_TIMEOUT_MS = Number(process.env.TABLM_MCP_TIMEOUT || 120_000);

console.log(`[mcp] MCP endpoint ready - token at ~/.tablm/mcp-token`);

function resolveInCwd(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(MCP_CWD, p);
}

function execCommand(command: string): Promise<string> {
  return new Promise((resolve) => {
    execCb(
      command,
      { cwd: MCP_CWD, timeout: MCP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let out = "";
        if (stdout) out += stdout;
        if (stderr) out += (out ? "\n[stderr]\n" : "") + stderr;
        if (err && !stdout && !stderr) out += `[error] ${err.message}`;
        resolve(out.slice(0, 20_000) || "(no output)");
      }
    );
  });
}

const MCP_TOOLS = [
  {
    name: "run_command",
    description:
      "Run a shell command on the user's real machine (has gh authenticated to their Git host, private network access, and all local files). Working directory is the user's home. Returns stdout+stderr.",
    inputSchema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file on the user's real machine. Returns the full content (capped at 50k chars).",
    inputSchema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write/create a file on the user's real machine. Returns the written byte count.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List entries of a directory on the user's real machine.",
    inputSchema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

async function callTool(
  name: string,
  args: any
): Promise<{ text: string; isError: boolean }> {
  try {
    switch (name) {
      case "run_command":
        return { text: await execCommand(String(args.command ?? "")), isError: false };
      case "read_file": {
        const p = resolveInCwd(String(args.path ?? ""));
        return {
          text: fs.readFileSync(p, "utf8").slice(0, 50_000),
          isError: false,
        };
      }
      case "write_file": {
        const p = resolveInCwd(String(args.path ?? ""));
        fs.writeFileSync(p, String(args.content ?? ""), "utf8");
        return {
          text: `wrote ${Buffer.byteLength(String(args.content ?? ""))} bytes to ${p}`,
          isError: false,
        };
      }
      case "list_dir": {
        const p = resolveInCwd(String(args.path ?? ""));
        return { text: fs.readdirSync(p).join("\n"), isError: false };
      }
      default:
        return { text: `unknown tool: ${name}`, isError: true };
    }
  } catch (e: any) {
    return { text: `[error] ${e.message ?? String(e)}`, isError: true };
  }
}

/**
 * Handle one MCP JSON-RPC message. Returns the JSON-RPC response object, or
 * null when the message is a notification (caller responds 202 Accepted).
 */
export async function handleMcpMessage(body: any): Promise<any | null> {
  const id = body?.id ?? null;
  const method = body?.method ?? "";

  const reply = (result: any) => ({ jsonrpc: "2.0", id, result });
  const replyError = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: typeof body?.params?.protocolVersion === "string"
          ? body.params.protocolVersion
          : "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tablm", version: "0.1.0" },
      });

    case "notifications/initialized":
      return null; // notification: no response body (202)

    case "ping":
      return reply({});

    case "tools/list":
      return reply({ tools: MCP_TOOLS });

    case "tools/call": {
      const name = String(body?.params?.name ?? "");
      const args = body?.params?.arguments ?? {};
      const { text, isError } = await callTool(name, args);
      return reply({
        content: [{ type: "text", text }],
        isError,
      });
    }

    default:
      return replyError(-32601, `method not found: ${method}`);
  }
}

export function mcpAuthorized(reqHeaders: IncomingHttpHeaders): boolean {
  const token = process.env.TABLM_MCP_TOKEN || MCP_TOKEN;
  const auth = reqHeaders["authorization"];
  if (typeof auth === "string" && auth === `Bearer ${token}`) return true;
  const apiKey = reqHeaders["x-api-key"];
  if (typeof apiKey === "string" && apiKey === token) return true;
  return false;
}
