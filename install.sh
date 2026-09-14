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

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [ ! -f "$DIR/package.json" ] || [ "${WEB2MODEL_FRESH_CLONE:-0}" = "1" ]; then
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
rm -f "$BIN_DIR/w2m-chrome" "$BIN_DIR/w2m-claude" "$BIN_DIR/w2m-gateway" "$APP_DIR/tablm.desktop" "$HOME/.config/autostart/tablm-chrome.desktop"
cat > "$BIN_DIR/tablm-gateway" <<EOF
#!/usr/bin/env bash
exec node "$DIR/dist/gateway.js" "$@" >> "$HOME/.web2model/gateway.log" 2>&1
EOF
chmod 755 "$BIN_DIR/tablm-gateway"
cat > "$BIN_DIR/tablm" <<EOF
#!/usr/bin/env bash
export ANTHROPIC_BASE_URL="\${ANTHROPIC_BASE_URL:-http://127.0.0.1:8788}"
export ANTHROPIC_AUTH_TOKEN="\${ANTHROPIC_AUTH_TOKEN:-tablm}"
export ANTHROPIC_MODEL="\${ANTHROPIC_MODEL:-web-chatgpt}"
exec claude "\$@"
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
mkdir -p "$HOME/.web2model"
tail -n 50 -f "$HOME/.web2model/gateway.log"
EOF
chmod 755 "$BIN_DIR/tablm-logs"
if systemctl --user status 2>/dev/null | grep -q "State:"; then
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

echo "[5/6] Starting gateway now"
if curl -s --max-time 3 http://127.0.0.1:8788/health >/dev/null 2>&1; then
  echo "  already running on :8788"
else
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-enabled tablm-gateway.service >/dev/null 2>&1; then
    systemctl --user restart tablm-gateway.service 2>/dev/null || nohup "$BIN_DIR/tablm-gateway" >/dev/null 2>&1 &
  else
    nohup "$BIN_DIR/tablm-gateway" >/dev/null 2>&1 &
  fi
  for _ in $(seq 1 20); do
    sleep 0.5
    curl -s --max-time 2 http://127.0.0.1:8788/health >/dev/null 2>&1 && break
  done
  curl -s --max-time 3 http://127.0.0.1:8788/health >/dev/null 2>&1 && echo "  running on :8788" || echo "  WARNING: not up yet - check tablm-logs"
fi

echo "[6/6] Checking Chrome"
CHROME_OK=0
for c in google-chrome-stable google-chrome chromium-browser chromium brave-browser microsoft-edge; do
  if command -v "$c" >/dev/null 2>&1; then CHROME_OK=1; echo "  found: $c"; break; fi
done
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
echo "     tablm-status    gateway + Chrome + sites health"
echo "     tablm-logs      tail the gateway log"
echo "     npm test        MCP smoke test (in $DIR)"
echo
echo "   The gateway autostarts at login."
echo "============================================================"
