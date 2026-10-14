// Standalone MCP-only server (default port 8790).
//
// Separate from the main gateway (8788) so a public tunnel can expose ONLY
// the MCP endpoint for ChatGPT connectors - without also exposing
// /v1/messages or the bridge. Token: ~/.tablm/mcp-token (same as gateway).

import http from "node:http";
import { handleMcpMessage, mcpAuthorized, MCP_TOKEN } from "./mcp.js";

const PORT = Number(process.env.TABLM_MCP_PORT || 8790);
const HOST = process.env.TABLM_MCP_HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  let body: any = {};
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "invalid JSON" } }));
      return;
    }
    let path = (req.url ?? "").split("?")[0];
    // ChatGPT connectors only support OAuth or No-auth (no custom headers).
    // Token-in-path lets "No authentication" clients stay token-gated:
    //   /mcp/<token>  -> authorized, routed as /mcp
    let pathToken: string | null = null;
    const pm = /^\/mcp\/([0-9a-f]{8,64})$/.exec(path);
    if (pm) {
      path = "/mcp";
      pathToken = pm[1];
    }
    const authorized = mcpAuthorized(req.headers) || (pathToken !== null && pathToken === MCP_TOKEN);
    if (req.method === "POST" && (path === "/mcp" || path === "/")) {
      if (!authorized) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" } }));
        return;
      }
      try {
        const rpcRes = await handleMcpMessage(body);
        if (rpcRes === null) {
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(rpcRes));
        }
      } catch (e: any) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } }));
      }
      return;
    }
    if (req.method === "GET" && (path === "/health" || path === "/mcp")) {
      res.writeHead(req.method === "GET" && path === "/health" ? 200 : 405, { "content-type": "application/json" });
      res.end(JSON.stringify(path === "/health" ? { ok: true, service: "tablm-mcp" } : { jsonrpc: "2.0", error: { code: -32000, message: "POST JSON-RPC" } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "not found" } }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mcp-server] tablm MCP listening on http://${HOST}:${PORT}/mcp`);
});
