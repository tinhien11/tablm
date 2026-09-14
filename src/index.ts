#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askSite, listSites, inspectDom, screenshotSite } from "./driver.js";

const server = new McpServer({ name: "web2model", version: "0.1.0" });

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

server.tool(
  "ask",
  "Send a prompt to a web AI chat (chatgpt, kimi) in the user's Chrome and return its reply. Sessions are mapped automatically: repeated calls continue the same web conversation; pass new_chat=true to start a fresh one.",
  {
    site: z.string().describe("site id: chatgpt | kimi"),
    prompt: z.string().describe("the prompt to send"),
    new_chat: z
      .boolean()
      .optional()
      .describe("start a fresh conversation instead of continuing the mapped one"),
    session: z
      .string()
      .optional()
      .describe("named session slot (default: one conversation per site)"),
    conversation_id: z
      .string()
      .optional()
      .describe("explicit conversation id (overrides session mapping)"),
    timeout_s: z
      .number()
      .optional()
      .describe("max seconds to wait for the reply (default 110)"),
  },
  async ({ site, prompt, new_chat, session, conversation_id, timeout_s }) => {
    try {
      const r = await askSite(site, prompt, {
        newChat: new_chat,
        session,
        conversationId: conversation_id,
        timeoutS: timeout_s,
      });
      const meta = `[web2model] site=${r.site} status=${r.status} conversation_id=${r.conversationId ?? "new"} session=${r.reused ? "continued" : "new"}${r.error ? " error=" + r.error : ""}`;
      const text = r.text ? `${r.text}\n\n${meta}` : meta;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          site: r.site,
          status: r.status,
          conversation_id: r.conversationId,
          session: r.reused ? "continued" : "new",
          text: r.text,
          error: r.error ?? null,
        },
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `web2model error: ${errText(e)}` }], isError: true };
    }
  }
);

server.tool(
  "list_sites",
  "List web AI sites supported by web2model and whether their tab is open, signed in, and ready.",
  {},
  async () => {
    try {
      const sites = await listSites();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(sites, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `web2model error: ${errText(e)}` }], isError: true };
    }
  }
);

server.tool(
  "inspect_dom",
  "Inspect the DOM of a web AI site tab to discover or fix selectors. Without a selector, dumps visible buttons and composer candidates.",
  {
    site: z.string().describe("site id: chatgpt | kimi"),
    selector: z.string().optional().describe("CSS selector to inspect specifically"),
  },
  async ({ site, selector }) => {
    try {
      const result = await inspectDom(site, selector);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `web2model error: ${errText(e)}` }], isError: true };
    }
  }
);

server.tool(
  "screenshot",
  "Take a screenshot of a web AI site tab (useful to see login walls, captchas, or errors).",
  { site: z.string().describe("site id: chatgpt | kimi") },
  async ({ site }) => {
    try {
      const data = await screenshotSite(site);
      return { content: [{ type: "image" as const, data, mimeType: "image/png" }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `web2model error: ${errText(e)}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
