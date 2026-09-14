#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/tinhien11/web2model.git"

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
  DIR="$HOME/web2model"
  if [ -f "$DIR/package.json" ]; then
    echo "Updating existing checkout at $DIR"
    git -C "$DIR" pull --ff-only || true
  else
    echo "Cloning web2model to $DIR"
    git clone --depth 1 "$REPO_URL" "$DIR"
  fi
fi
cd "$DIR"

echo "[1/5] Installing dependencies"
npm install --silent

echo "[2/5] Building"
npm run build --silent

echo "[3/5] Registering MCP server with Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove web2model >/dev/null 2>&1 || true
  claude mcp add -s user web2model -- node "$PWD/dist/index.js" 2>/dev/null ||
    claude mcp add web2model -- node "$PWD/dist/index.js" || true
  echo "  registered: web2model -> node $PWD/dist/index.js"
else
  echo "  claude CLI not found. Add manually later:"
  echo "    claude mcp add -s user web2model -- node $PWD/dist/index.js"
fi

echo "[4/5] Installing gateway launcher + autostart"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
mkdir -p "$BIN_DIR" "$APP_DIR" "$HOME/.config/autostart"
rm -f "$BIN_DIR/w2m-chrome" "$APP_DIR/web2model.desktop" "$HOME/.config/autostart/web2model-chrome.desktop"
cat > "$BIN_DIR/w2m-gateway" <<EOF
#!/usr/bin/env bash
exec node "$DIR/dist/gateway.js" "\$@"
EOF
chmod 755 "$BIN_DIR/w2m-gateway"
cat > "$BIN_DIR/w2m-claude" <<EOF
#!/usr/bin/env bash
export ANTHROPIC_BASE_URL="\${ANTHROPIC_BASE_URL:-http://127.0.0.1:8788}"
export ANTHROPIC_AUTH_TOKEN="\${ANTHROPIC_AUTH_TOKEN:-web2model}"
export ANTHROPIC_MODEL="\${ANTHROPIC_MODEL:-web-chatgpt}"
exec claude "\$@"
EOF
chmod 755 "$BIN_DIR/w2m-claude"
cat > "$HOME/.config/autostart/web2model-gateway.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=web2model Gateway
Comment=Anthropic-compatible gateway backed by web AI chats (auto-opens Chrome on first ask)
Exec=$BIN_DIR/w2m-gateway
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
update-desktop-database "$APP_DIR" 2>/dev/null || true

echo "[5/5] Checking Chrome"
CHROME_OK=0
for c in google-chrome-stable google-chrome chromium-browser chromium brave-browser microsoft-edge; do
  if command -v "$c" >/dev/null 2>&1; then CHROME_OK=1; echo "  found: $c"; break; fi
done
if [ "$CHROME_OK" = "0" ]; then
  echo "  WARNING: no Chrome/Chromium/Edge found - install one; it auto-launches on first ask"
fi

echo
echo "Done. Everything is automatic now:"
echo "  - gateway autostarts at login (Chrome auto-opens on first ask)"
echo "  - start Claude Code on the web model:  w2m-claude"
echo "  - model ids: web-chatgpt, web-zai, web-kimi"
echo "  - first run: sign in to the sites you want in the Chrome window that opens"
