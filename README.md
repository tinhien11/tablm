# tablm

Use web AI chats (ChatGPT, Z.ai GLM, Kimi) as local coding agents -- **no API keys, no subscriptions**.

tablm opens a Chrome window where you sign in to your AI chat once. Your terminal agent then talks to that web chat: it translates tool calls (run commands, read/write files, browse) so the web model can actually work on your machine.

## How it works

```
tablm (agent)            gateway (translator)         web chat (model)
     |                        |                            |
     |-- user prompt -------->|                            |
     |   + 12 tools schema    |-- paste prompt ----------->|
     |                        |   + tool protocol block    |
     |                        |<-- text streaming ---------|
     |                        |    (may contain tooluse)   |
     |<-- tool_use event -----|                            |
     |                        |                            |
     |-- execute tool locally |                            |
     |<-- result string       |                            |
     |                        |                            |
     |-- tool_result -------->|-- paste result ----------->|
     |                        |<-- text / tooluse ---------|
     |<-- final text ---------|                            |
```

The web model has no tool API, so the gateway injects a small protocol that teaches it to emit `tooluse` blocks, parses them into real tool calls, runs them **locally**, and pastes results back into the same conversation.

## Requirements

- Node.js 18+
- git
- Chrome / Chromium / Edge

## Quick start

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/tinhien11/tablm/main/install.sh | bash
tablm "list files in this folder and explain the project"
```

(Open a **new terminal** after install so `tablm` is on your PATH.)

**First run:** a dedicated Chrome window opens -- sign in to your AI chat once. Cookies persist, so you only do this one time.

## Usage

```
tablm "fix the failing test"    # one-shot task
tablm                           # interactive REPL (follow-ups share context)
tablm claude                    # route Claude Code CLI through the gateway (optional)
tablm codex                     # route codex CLI through the gateway (optional)
```

Built-in tools: Bash, Read, Write, Edit, Grep, Glob, BrowserNavigate, BrowserSnapshot, BrowserClick, BrowserFill, BrowserScreenshot, BrowserEval.

## Models

| Model id | Site | Login |
|---|---|---|
| `web-zai` (default) | chat.z.ai | optional |
| `web-chatgpt` | chatgpt.com | optional (anonymous works) |
| `web-kimi` | kimi.ai | required |

Switch model: `export TABLM_MODEL=web-chatgpt`

## Useful commands

```
tablm-status                    # is the gateway running?
tablm-logs                      # tail gateway logs
tablm-gateway                   # start/stop the gateway manually
npm test                        # run tests (from the repo)
curl -s http://127.0.0.1:8788/health
tail -f ~/.tablm/gateway.log
```

## Troubleshooting

- **Gateway not responding?** `curl -s http://127.0.0.1:8788/health`
- **Site changed and tools fail?** Use the `inspect_dom` MCP tool to discover new selectors, then edit `~/.tablm/sites.json`
- **Login wall / captcha?** Use the `screenshot` MCP tool to see the page, sign in inside the tablm Chrome window
