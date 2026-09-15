# tablm

Use web AI chats (ChatGPT, Z.ai GLM, Kimi) as local coding agents - no API keys, no Anthropic login.

## Architecture

A translating gateway (:8788) lets standard agent clients drive text-only web chats. The web model has no tool API, so the gateway injects a `[Tool use protocol]` block teaching it to emit fenced `tooluse {"name":"Bash","input":{...}}` blocks, parses those back into `tool_use` events, and pastes each `tool_result` into the same web chat conversation (session map in `~/.tablm/sessions.json`). One tool round-trip = one web chat call (8-30s latency).

```text
tablm (agent)              gateway (translator)         web chat (model)
     │                          │                            │
     │── user prompt ──────────>│                            │
     │   + 12 tools schema      │── paste prompt ───────────>│
     │                          │   + tool protocol block    │
     │                          │<── text streaming ─────────│
     │                          │    (may contain tooluse)   │
     │<── tool_use event ───────│                            │
     │                          │                            │
     │── execute tool locally   │                            │
     │<── result string         │                            │
     │                          │                            │
     │── tool_result ──────────>│── paste result ───────────>│
     │                          │<── text / tooluse ─────────│
     │                          │                            │
     │<── final text ───────────│                            │
```

Two clients drive the same gateway:

- **tablm** (default) - built-in lean agent with 12 tools and a short system prompt (~95% smaller than Claude Code's). REPL session mode keeps context across follow-up prompts.
- **Claude Code / codex** - `tablm claude` / `tablm codex` route the installed CLIs through the gateway. Claude Code sends 100+ tools + its full system prompt; the gateway translates Anthropic `tool_use` SSE events both ways and Claude Code executes tools locally.

## Install

Requirements: Node.js 18+, git, Google Chrome/Chromium/Edge. Claude Code CLI is optional - `tablm` is the default built-in client.

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/tinhien11/tablm/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/tinhien11/tablm.git && cd tablm
./install.sh
tablm
```

### Windows (PowerShell)

```powershell
git clone https://github.com/tinhien11/tablm.git $env:USERPROFILE\tablm
cd $env:USERPROFILE\tablm
npm install; npm run build
node install.mjs
tablm
```

Launchers (`tablm`, `tablm-status`, `tablm-logs`, `tablm-gateway`) are `.cmd` files in `%USERPROFILE%\.tablm\bin` (added to user PATH - open a new terminal). The gateway autostarts via the Startup folder.

First run opens a dedicated Chrome window (`~/.tablm/chrome-profile`). Sign in to the sites you want once - cookies persist.

### tablm CLI

```bash
tablm "read HANDOFF.md and continue the loop"
> grep for X in the findings index      # follow-up, same session
> exit

tablm claude                            # route the claude CLI through the gateway (if installed)
tablm codex                             # route the codex CLI through the gateway (if installed)
```

The 12 built-in tools: Bash, Read, Write, Edit, Grep, Glob, BrowserNavigate, BrowserSnapshot, BrowserClick, BrowserFill, BrowserScreenshot, BrowserEval.

## Extension mode (optional - remote Chrome with your real profile)

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

Config files: per-site selectors in `~/.tablm/sites.json` (deep-merged over defaults), session map in `~/.tablm/sessions.json`.

| Env var | Default | Purpose |
|---|---|---|
| `TABLM_MODEL` | `web-zai` | Model id for the built-in agent |
| `TABLM_MAX_TURNS` | `50` | Max tool round-trips per agent run |
| `TABLM_AUTH_TOKEN` | `tablm` | Token the agent sends to the gateway |
| `TABLM_GATEWAY_URL` | `http://127.0.0.1:8788` | Gateway endpoint (agent) |
| `TABLM_GATEWAY_HTTP` | `http://127.0.0.1:8788` | Gateway endpoint (MCP server) |
| `TABLM_GATEWAY_PORT` | `8788` | Gateway listen port |
| `TABLM_GATEWAY_HOST` | `127.0.0.1` | Gateway bind host |
| `TABLM_GATEWAY_TOKEN` | (unset) | Require auth on the gateway (clients set `ANTHROPIC_AUTH_TOKEN`) |
| `TABLM_DEFAULT_SITE` | `zai` | Site used when the client doesn't pick one |
| `TABLM_MAX_REPAIRS` | `3` | Gateway retries when a tooluse block fails to parse |
| `TABLM_TRANSPORT` | `cdp` | `cdp` or `extension` (per-site override via sites.json) |
| `TABLM_CDP_URL` | `http://127.0.0.1:9222` | Chrome DevTools endpoint |
| `TABLM_NO_LOCAL_CHROME` | (unset) | `1` = never launch local Chrome (remote CDP only) |
| `TABLM_CHROME_BIN` | auto-detect | Chrome/Chromium/Edge binary |
| `TABLM_CHROME_PROFILE` | `~/.tablm/chrome-profile` | Persistent Chrome profile |
| `TABLM_BRIDGE_PORT` | `8765` | Extension bridge WebSocket port |
| `TABLM_BRIDGE_TOKEN` | falls back to `TABLM_GATEWAY_TOKEN` | Extension bridge auth |
| `TABLM_SITES_CONFIG` | `~/.tablm/sites.json` | Per-site selectors/settings |
| `TABLM_SESSIONS` | `~/.tablm/sessions.json` | Session map |

## Adding a site

Add one object to `SITES` in `src/transport/driver.ts` (selectors + URL patterns), rebuild. Use the `inspect_dom` MCP tool against the live site to discover selectors.

## Verify

```bash
npm test                        # protocol parse tests + MCP smoke test
curl -s http://127.0.0.1:8788/health
tail -f ~/.tablm/gateway.log    # prompt sizes, delta/full mode, tool_calls
```
