#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/4] Installing dependencies"
npm install --silent

echo "[2/4] Building"
npm run build --silent

echo "[3/4] Registering MCP server with Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove web2model >/dev/null 2>&1 || true
  claude mcp add -s user web2model -- node "$PWD/dist/index.js" 2>/dev/null ||
    claude mcp add web2model -- node "$PWD/dist/index.js" || true
  echo "  registered: web2model -> node $PWD/dist/index.js"
else
  echo "  claude CLI not found. Add manually:"
  echo "    claude mcp add -s user web2model -- node $PWD/dist/index.js"
fi

echo "[4/5] Installing gateway launcher + autostart"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
mkdir -p "$BIN_DIR" "$APP_DIR" "$HOME/.config/autostart"
rm -f "$BIN_DIR/w2m-chrome" "$APP_DIR/web2model.desktop" "$HOME/.config/autostart/web2model-chrome.desktop"
cat > "$BIN_DIR/w2m-gateway" <<EOF
#!/usr/bin/env bash
exec node "$PWD/dist/gateway.js" "\$@"
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

echo
echo "Done. Everything is automatic now:"
echo "  - gateway autostarts at login (Chrome auto-opens on first ask)"
echo "  - start Claude Code on the web model:  w2m-claude"
echo "  - model ids: web-chatgpt, web-kimi"
