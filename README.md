# tablm

Use web AI chats (ChatGPT, Z.ai GLM, Kimi) as local models for Claude Code - no API keys, no Anthropic login.

```
Claude Code ──(Anthropic API)──> Gateway :8788 ──(CDP)──> Chrome ──> chatgpt.com / chat.z.ai / kimi.ai
```

- **Gateway**: Anthropic-compatible HTTP server (port 8788). Translates Claude Code conversations into web chat prompts, and web replies back into Anthropic format (including `thinking` and `tool_use` blocks).
- **Tool-call bridge**: the web model can call Claude Code's tools (Bash, Read, Edit...) - the gateway translates its ```tooluse``` blocks into real tool_use blocks, Claude Code executes them locally.
- **Session mapping**: each site keeps one live web conversation; only the message delta is sent after the first turn.
- **Auto-launch**: Chrome with a dedicated debug profile starts automatically on first use (Chrome 136+ forbids CDP on the default profile).

## Architecture

Two clients can drive the same gateway:

### Claude Code (MCP mode)

```
Claude Code ──(Anthropic API)──> Gateway :8788 ──(CDP)──> Chrome ──> web chat
```

Claude Code sends 100+ tools and its full system prompt. The gateway forwards them to the web model, which returns ```tooluse``` blocks. The gateway translates those into Anthropic `tool_use` SSE events. Claude Code executes the tools locally and sends `tool_result` back. The gateway pastes the result into the web chat as the next message; the model reads it and continues.

### tablm-cli (lean agent mode)

`tablm-cli` is a minimal autonomous agent that ships with tablm. It exposes only 6 tools (Bash, Read, Write, Edit, Grep, Glob) and a short system prompt, so the prompt sent to the web model is ~95% smaller than Claude Code's. It runs in a REPL: the first prompt is a CLI arg, follow-up prompts keep the same session (same `messages[]`, same web chat conversation).

```
tablm-cli (agent)          gateway (translator)         web chat (model)
     │                          │                            │
     │── user prompt ──────────>│                            │
     │   + 6 tools schema        │── paste prompt ───────────>│
     │                          │   + tool protocol block     │
     │                          │<── text streaming ──────────│
     │                          │    (may contain ```tooluse```)│
     │<── SSE: tool_use block ──│                            │
     │                          │                            │
     │── execute Bash locally   │                            │
     │<── result string         │                            │
     │                          │                            │
     │── tool_result ──────────>│── paste result ───────────>│
     │                          │<── text/tooluse ────────────│
     │                          │                            │
     │<── SSE: final text ─────│                            │
```

Key points:
- The web model has no real tool API. The gateway injects a `[Tool use protocol]` text block that teaches the model to emit ```tooluse {"name":"Bash","input":{...}}``` fenced blocks.
- The gateway parses those blocks and emits Anthropic `tool_use` SSE events.
- `tablm-cli` executes the tool locally and sends `tool_result` back. The gateway pastes it into the same web chat conversation (session mapping in `~/.tablm/sessions.json`), so the model sees the result as the next message and continues.
- Each tool round-trip is one web chat call (8-30s latency). 10 tool calls = 10 web calls = 2-5 minutes.

Usage:

```bash
tablm-cli "read HANDOFF.md and continue the loop"
> grep for X in the findings index      # follow-up, same session
> exit
```

Env: `TABLM_MODEL` (default `web-zai`), `TABLM_MAX_TURNS` (default 50), `TABLM_GATEWAY_URL` (default `http://127.0.0.1:8788`), `TABLM_AUTH_TOKEN` (default `tablm`).

## Install (any machine)

Requirements: Node.js 18+, git, Google Chrome/Chromium/Edge, [Claude Code](https://claude.com/claude-code) CLI.

### Linux / macOS

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/tinhien11/tablml/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/tinhien11/tablml.git && cd tablm
./install.sh
tablm
```

### Windows (PowerShell)

```powershell
git clone https://github.com/tinhien11/tablml.git $env:USERPROFILE\tablml
cd $env:USERPROFILE\tablml
npm install; npm run build
node install.mjs
tablm
```

Launchers (`tablm`, `tablm-status`, `tablm-logs`, `tablm-gateway`) are `.cmd` files in `%USERPROFILE%\.tablm\bin` (added to user PATH - open a new terminal after install). Gateway autostarts via the Startup folder.

`install.sh` does everything: installs dependencies, builds, registers the MCP server with Claude Code (user scope), installs the gateway autostart entry and the `tablm` / `tablm-gateway` launchers.

First run: a dedicated Chrome window opens (`~/.tablm/chrome-profile`). Sign in to the sites you want once - cookies persist.

### Extension mode (optional - remote Chrome with your real profile)

For the VM scenario: the gateway runs anywhere (VM/container), and a browser extension drives Chrome on the host machine using its **real profile** (no CDP flags, no separate login). The extension speaks the `fancy-browser/1` protocol and ships battle-tested site adapters (chatgpt, kimi, glm/z.ai, gemini, grok).

1. Start the gateway - the bridge listens on `ws://0.0.0.0:8765` (override with `TABLM_BRIDGE_PORT`; protect it with `TABLM_BRIDGE_TOKEN`)
2. Load the extension in host Chrome: `chrome://extensions` -> Developer mode -> Load unpacked (use the fancy-gpt exported bundle - `fancy-gpt extension export --browser chrome`)
3. In the extension popup: endpoint `ws://<gateway-ip>:8765` + token -> Connect
4. Enable the transport - globally (`TABLM_TRANSPORT=extension`) or per site in `~/.tablm/sites.json`:

```json
{ "zai": { "transport": "extension" } }
```

Site mapping over the extension: `chatgpt -> chatgpt`, `kimi -> kimi`, `zai -> glm`.

## Model ids

| Model | Site | Login |
|---|---|---|
| `web-chatgpt` | chatgpt.com | optional (anonymous works) |
| `web-zai` | chat.z.ai | optional |
| `web-kimi` | kimi.ai | required |

## MCP tools (usable from any MCP client)

- `ask(site, prompt, new_chat?, session?, timeout_s?)` - send a prompt, get the reply
- `list_sites()` - tab/health status per site
- `inspect_dom(site, selector?)` - dump DOM candidates to fix selectors when a site changes
- `screenshot(site)` - see what the web page shows (login walls, captchas)

## Configuration

- Selectors per site: `~/.tablm/sites.json` (deep-merged over defaults)
- Session map: `~/.tablm/sessions.json`
- Env: `TABLM_CDP_URL` (default `http://127.0.0.1:9222`), `TABLM_GATEWAY_PORT` (8788), `TABLM_CHROME_BIN`, `TABLM_CHROME_PROFILE`, `TABLM_SITES_CONFIG`, `TABLM_SESSIONS`

## Adding a site

Add one object to `SITES` in `src/driver.ts` (selectors + URL patterns), rebuild. Use the `inspect_dom` MCP tool against the live site to discover selectors.

## Verify

```bash
npm test                # MCP smoke test
curl -s http://127.0.0.1:8788/health
grep prompt= /tmp/tablm-gw.log   # gateway log: prompt sizes, delta/full mode, tool_calls
```
