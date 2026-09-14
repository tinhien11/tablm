# tablm

Use web AI chats (ChatGPT, Z.ai GLM, Kimi) as local models for Claude Code - no API keys, no Anthropic login.

```
Claude Code ──(Anthropic API)──> Gateway :8788 ──(CDP)──> Chrome ──> chatgpt.com / chat.z.ai / kimi.ai
```

- **Gateway**: Anthropic-compatible HTTP server (port 8788). Translates Claude Code conversations into web chat prompts, and web replies back into Anthropic format (including `thinking` and `tool_use` blocks).
- **Tool-call bridge**: the web model can call Claude Code's tools (Bash, Read, Edit...) - the gateway translates its ```tooluse``` blocks into real tool_use blocks, Claude Code executes them locally.
- **Session mapping**: each site keeps one live web conversation; only the message delta is sent after the first turn.
- **Auto-launch**: Chrome with a dedicated debug profile starts automatically on first use (Chrome 136+ forbids CDP on the default profile).

## Install (any machine)

Requirements: Node.js 18+, git, Google Chrome/Chromium/Edge, [Claude Code](https://claude.com/claude-code) CLI.

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/tinhien11/tablm/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/tinhien11/tablm.git && cd tablm
./install.sh
w2m-claude
```

`install.sh` does everything: installs dependencies, builds, registers the MCP server with Claude Code (user scope), installs the gateway autostart entry and the `w2m-claude` / `w2m-gateway` launchers.

First run: a dedicated Chrome window opens (`~/.tablm/chrome-profile`). Sign in to the sites you want once - cookies persist.

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
- Env: `WEB2MODEL_CDP_URL` (default `http://127.0.0.1:9222`), `WEB2MODEL_GATEWAY_PORT` (8788), `WEB2MODEL_CHROME_BIN`, `WEB2MODEL_CHROME_PROFILE`, `WEB2MODEL_SITES_CONFIG`, `WEB2MODEL_SESSIONS`

## Adding a site

Add one object to `SITES` in `src/driver.ts` (selectors + URL patterns), rebuild. Use the `inspect_dom` MCP tool against the live site to discover selectors.

## Verify

```bash
npm test                # MCP smoke test
curl -s http://127.0.0.1:8788/health
grep prompt= /tmp/w2m-gw.log   # gateway log: prompt sizes, delta/full mode, tool_calls
```
