#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/tinhien11/tablm.git"

fail() {
  echo "ERROR: $1" >&2
  echo "Install it first, then re-run this script." >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 18+ is required (https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js 18+ required, found $(node --version)"
command -v git >/dev/null 2>&1 || fail "git is required"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
if [ ! -f "$DIR/package.json" ] || [ "${TABLM_FRESH_CLONE:-0}" = "1" ]; then
  DIR="$HOME/tablm"
  if [ -f "$DIR/package.json" ]; then
    echo "Updating existing checkout at $DIR"
    git -C "$DIR" pull --ff-only || true
  else
    echo "Cloning tablm to $DIR"
    git clone --depth 1 "$REPO_URL" "$DIR"
  fi
fi
cd "$DIR"

echo "[1/6] Installing dependencies"
npm install --silent

echo "[2/6] Building"
npm run build --silent

echo "[3/6] Registering MCP server with Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove tablm >/dev/null 2>&1 || true
  claude mcp add -s user tablm -- node "$PWD/dist/index.js" 2>/dev/null ||
    claude mcp add tablm -- node "$PWD/dist/index.js" || true
  echo "  registered: tablm -> node $PWD/dist/index.js"
else
  echo "  claude CLI not found. Add manually later:"
  echo "    claude mcp add -s user tablm -- node $PWD/dist/index.js"
fi

echo "[4/6] Installing gateway launcher + autostart"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
mkdir -p "$BIN_DIR" "$APP_DIR" "$HOME/.config/autostart"
rm -f "$BIN_DIR/tablm-chrome" "$BIN_DIR/tablm-claude" "$BIN_DIR/tablm-gateway" "$APP_DIR/tablm.desktop" "$HOME/.config/autostart/tablm-chrome.desktop"
# systemd user services run with a minimal PATH that excludes nvm/volta, so resolve
# the node binary to an absolute path now and bake it into the launchers.
NODE_BIN="$(command -v node)"
cat > "$BIN_DIR/tablm-gateway" <<EOF
#!/usr/bin/env bash
export PATH="$(dirname "$NODE_BIN"):\$PATH"
exec "$NODE_BIN" "$DIR/dist/gateway.js" "\$@" >> "$HOME/.tablm/gateway.log" 2>&1
EOF
chmod 755 "$BIN_DIR/tablm-gateway"
cat > "$BIN_DIR/tablm" <<EOF
#!/usr/bin/env bash
export ANTHROPIC_BASE_URL="\${ANTHROPIC_BASE_URL:-http://127.0.0.1:8788}"
export ANTHROPIC_AUTH_TOKEN="\${ANTHROPIC_AUTH_TOKEN:-tablm}"
export ANTHROPIC_MODEL="\${ANTHROPIC_MODEL:-web-zai}"
if command -v claude >/dev/null 2>&1; then
  exec claude "\$@"
fi
# claude CLI not installed - use the built-in chat CLI (same gateway, same model ids)
echo "claude CLI not found - using built-in tablm CLI (npm i -g @anthropic-ai/claude-code for the real one)" >&2
export TABLM_GATEWAY_URL="\$ANTHROPIC_BASE_URL" TABLM_AUTH_TOKEN="\$ANTHROPIC_AUTH_TOKEN" TABLM_MODEL="\$ANTHROPIC_MODEL"
exec "$NODE_BIN" "$DIR/dist/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/tablm"
cat > "$BIN_DIR/tablm-status" <<'EOF'
#!/usr/bin/env bash
echo "== gateway =="
curl -s --max-time 3 http://127.0.0.1:8788/health || echo "gateway DOWN (start: tablm-gateway &)"
echo
echo "== chrome (CDP :9222) =="
curl -s --max-time 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && echo "up" || echo "not running (auto-launches on first ask)"
echo
echo "== site tabs =="
node -e 'fetch("http://127.0.0.1:9222/json").then(r=>r.json()).then(t=>t.filter(x=>x.type==="page").forEach(x=>console.log(" "+x.url.slice(0,80)))).catch(()=>console.log(" (chrome not running)"))'
EOF
chmod 755 "$BIN_DIR/tablm-status"
cat > "$BIN_DIR/tablm-logs" <<EOF
#!/usr/bin/env bash
mkdir -p "$HOME/.tablm"
tail -n 50 -f "$HOME/.tablm/gateway.log"
EOF
chmod 755 "$BIN_DIR/tablm-logs"
cat > "$BIN_DIR/tablm-cli" <<EOF
#!/usr/bin/env bash
export PATH="$(dirname "$NODE_BIN"):\$PATH"
exec "$NODE_BIN" "$DIR/dist/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/tablm-cli"

if [ -n "${TABLM_GATEWAY_HOST:-}" ]; then
  sed -i.bak "s|^exec node|export TABLM_GATEWAY_HOST=\"$TABLM_GATEWAY_HOST\"\\nexec node|" "$BIN_DIR/tablm-gateway" && rm -f "$BIN_DIR/tablm-gateway.bak"
fi
if [ -n "${TABLM_GATEWAY_TOKEN:-}" ]; then
  sed -i.bak "s|^exec node|export TABLM_GATEWAY_TOKEN=\"$TABLM_GATEWAY_TOKEN\"\\nexec node|" "$BIN_DIR/tablm-gateway" && rm -f "$BIN_DIR/tablm-gateway.bak"
fi

case "$(uname -s)" in
  Darwin)
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$HOME/Library/LaunchAgents/com.tablm.gateway.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tablm.gateway</string>
  <key>ProgramArguments</key><array><string>$BIN_DIR/tablm-gateway</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
    launchctl unload "$HOME/Library/LaunchAgents/com.tablm.gateway.plist" >/dev/null 2>&1 || true
    launchctl load "$HOME/Library/LaunchAgents/com.tablm.gateway.plist" >/dev/null 2>&1 || true
    echo "  macOS LaunchAgent installed (KeepAlive)"
    ;;
  Linux)
    if systemctl --user status >/dev/null 2>&1; then
      SYSTEMD_DIR="$HOME/.config/systemd/user"
      mkdir -p "$SYSTEMD_DIR"
      cat > "$SYSTEMD_DIR/tablm-gateway.service" <<EOF
[Unit]
Description=tablm gateway (web AI chats as Anthropic-compatible model)
[Service]
ExecStart=$BIN_DIR/tablm-gateway
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now tablm-gateway.service >/dev/null 2>&1 || true
      echo "  systemd user service: tablm-gateway (enabled)"
    else
      cat > "$HOME/.config/autostart/tablm-gateway.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=tablm Gateway
Comment=Anthropic-compatible gateway backed by web AI chats (auto-opens Chrome on first ask)
Exec=$BIN_DIR/tablm-gateway
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
      update-desktop-database "$APP_DIR" 2>/dev/null || true
      echo "  .desktop autostart installed"
    fi
    ;;
esac

for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [ -f "$rc" ] && ! grep -q "tablm PATH" "$rc" 2>/dev/null; then
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\" # tablm PATH" >> "$rc"
    PATH_NOTE=1
  fi
done
[ "${PATH_NOTE:-0}" = "1" ] && echo "  PATH updated in ~/.zshrc / ~/.bashrc (open a NEW terminal or: source ~/.zshrc)"

echo "[5/6] Starting gateway now"
if curl -s --max-time 3 http://127.0.0.1:8788/health >/dev/null 2>&1; then
  echo "  already running on :8788"
else
  if [ "$(uname -s)" = "Darwin" ]; then
    launchctl kickstart -k "gui/$(id -u)/com.tablm.gateway" >/dev/null 2>&1 || nohup "$BIN_DIR/tablm-gateway" >/dev/null 2>&1 &
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user is-enabled tablm-gateway.service >/dev/null 2>&1; then
    systemctl --user restart tablm-gateway.service 2>/dev/null || nohup "$BIN_DIR/tablm-gateway" >/dev/null 2>&1 &
  else
    nohup "$BIN_DIR/tablm-gateway" >/dev/null 2>&1 &
  fi
  for _ in $(seq 1 30); do
    sleep 0.5
    curl -s --max-time 2 http://127.0.0.1:8788/health >/dev/null 2>&1 && break
  done
  if curl -s --max-time 3 http://127.0.0.1:8788/health >/dev/null 2>&1; then
    echo "  running on :8788"
  else
    echo "  WARNING: not up yet - last log lines:"
    tail -n 5 "$HOME/.tablm/gateway.log" 2>/dev/null || echo "  (no log file)"
  fi
fi

echo "[6/6] Checking Chrome"
CHROME_OK=0
if [ "$(uname -s)" = "Darwin" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
    if [ -x "$c" ]; then CHROME_OK=1; echo "  found: $c"; break; fi
  done
else
  for c in google-chrome-stable google-chrome chromium-browser chromium brave-browser microsoft-edge; do
    if command -v "$c" >/dev/null 2>&1; then CHROME_OK=1; echo "  found: $c"; break; fi
  done
fi
if [ "$CHROME_OK" = "0" ]; then
  echo "  WARNING: no Chrome/Chromium/Edge found - install one; it auto-launches on first ask"
fi

echo
echo "============================================================"
echo " tablm installed. Next steps:"
echo
echo "   1. Run:            tablm"
echo "      (a Chrome window opens on first use - sign in to"
echo "       chatgpt.com / chat.z.ai / kimi.ai once, cookies persist)"
echo
echo "   2. Model ids:      web-chatgpt | web-zai | web-kimi"
echo "      switch with:    tablm --model web-zai"
echo
echo "   Useful commands:"
echo "     tablm-cli       built-in chat CLI (works even without the claude CLI)"
echo "     tablm-status    gateway + Chrome + sites health"
echo "     tablm-logs      tail the gateway log"
echo "     npm test        MCP smoke test (in $DIR)"
echo
echo "   The gateway autostarts at login."
if [ "${TABLM_GATEWAY_HOST:-}" = "0.0.0.0" ]; then
  LAN_IP=$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  [ -z "$LAN_IP" ] && LAN_IP=$(ifconfig 2>/dev/null | grep 'inet ' | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
  echo
  echo "   LAN access (host 0.0.0.0):"
  echo "     ANTHROPIC_BASE_URL=http://${LAN_IP:-<VM_IP>}:8788 ANTHROPIC_AUTH_TOKEN=\${TABLM_GATEWAY_TOKEN:-tablm} claude"
  [ -n "${TABLM_GATEWAY_TOKEN:-}" ] || echo "     (tip: set TABLM_GATEWAY_TOKEN before install to protect the port)"
fi
echo "============================================================"
