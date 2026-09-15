# tablm

Use web AI chats (ChatGPT, Z.ai GLM, Kimi) as local models - no API keys, no Anthropic login.

## Architecture

```
tablm (agent)              gateway (translator)         web chat (model)
     │                          │                            │
     │── user prompt ──────────>│                            │
     │   + 12 tools schema      │── paste prompt ───────────>│
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

Two clients drive the same gateway (`:8788`):

- **Claude Code** (MCP mode): sends 100+ tools + full system prompt. Gateway forwards to web model, translates ```tooluse``` blocks back into Anthropic `tool_use` SSE events. Claude Code executes tools locally.
- **tablm** (built-in lean agent, the default): 12 tools (Bash, Read, Write, Edit, Grep, Glob + browser tools), short system prompt. ~95% smaller prompt than Claude Code. REPL session mode keeps context across follow-up prompts.

The web model has no real tool API. The gateway injects a `[Tool use protocol]` text block teaching the model to emit ```tooluse {"name":"Bash","input":{...}}``` fenced blocks. The gateway parses those into `tool_use` events; the client executes the tool and sends `tool_result` back; the gateway pastes it into the same web chat conversation (session mapping in `~/.tablm/sessions.json`).

Each tool round-trip is one web chat call (8-30s latency).

## Install

Requirements: Node.js 18+, git, Google Chrome/Chromium/Edge. Claude Code CLI is optional - `tablm` is the default built-in client (`tablm claude` routes the Claude Code CLI through the gateway when installed).

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

Launchers (`tablm`, `tablm-status`, `tablm-logs`, `tablm-gateway`) are `.cmd` files in `%USERPROFILE%\.tablm\bin` (added to user PATH - open a new terminal). Gateway autostarts via the Startup folder.

First run: a dedicated Chrome window opens (`~/.tablm/chrome-profile`). Sign in to the sites you want once - cookies persist.

### tablm CLI (built-in - the default client)

```bash
tablm "read HANDOFF.md and continue the loop"
> grep for X in the findings index      # follow-up, same session
> exit

tablm claude                            # route the claude CLI through the gateway (if installed)
tablm codex                             # route the codex CLI through the gateway (if installed)
```

Env: `TABLM_MODEL` (default `web-zai`), `TABLM_MAX_TURNS` (default 50), `TABLM_GATEWAY_URL` (default `http://127.0.0.1:8788`), `TABLM_AUTH_TOKEN` (default `tablm`).

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

- Selectors per site: `~/.tablm/sites.json` (deep-merged over defaults)
- Session map: `~/.tablm/sessions.json`
- Env: `TABLM_CDP_URL` (default `http://127.0.0.1:9222`), `TABLM_GATEWAY_PORT` (8788), `TABLM_CHROME_BIN`, `TABLM_CHROME_PROFILE`, `TABLM_SITES_CONFIG`, `TABLM_SESSIONS`

## Adding a site

Add one object to `SITES` in `src/driver.ts` (selectors + URL patterns), rebuild. Use the `inspect_dom` MCP tool against the live site to discover selectors.

## Verify

```bash
npm test                # MCP smoke test
curl -s http://127.0.0.1:8788/health
tail -f ~/.tablm/gateway.log   # prompt sizes, delta/full mode, tool_calls
```
