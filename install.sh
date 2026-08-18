#!/usr/bin/env bash
set -e

CONFIG_DIR="$HOME/.config/opencode"
PLUGINS_DIR="$CONFIG_DIR/plugins"
COMMAND_DIR="$CONFIG_DIR/command"

mkdir -p "$PLUGINS_DIR" "$COMMAND_DIR"

REPO_RAW="https://raw.githubusercontent.com/hithismani/opencode-budget-allowance/main"

# When run from a clone, files live next to this script. When piped via
# curl | bash, BASH_SOURCE resolves to the caller's cwd, so detect that and
# download the files from GitHub instead of cp-ing from a nonexistent path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"

if [ -f "$SCRIPT_DIR/src/budget.ts" ]; then
  SRC_DIR="$SCRIPT_DIR"
  echo "📦 Installing from local clone: $SRC_DIR"
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  mkdir -p "$TMP_DIR/src" "$TMP_DIR/command"
  echo "⬇️  Downloading plugin files from GitHub..."
  curl -fsSL "$REPO_RAW/src/budget.ts" -o "$TMP_DIR/src/budget.ts"
  curl -fsSL "$REPO_RAW/src/cli.ts" -o "$TMP_DIR/src/cli.ts"
  curl -fsSL "$REPO_RAW/command/budget-allowance.md" -o "$TMP_DIR/command/budget-allowance.md"
  SRC_DIR="$TMP_DIR"
fi

cp "$SRC_DIR/src/budget.ts" "$PLUGINS_DIR/budget.ts"
cp "$SRC_DIR/src/cli.ts" "$PLUGINS_DIR/cli.ts"
cp "$SRC_DIR/command/budget-allowance.md" "$COMMAND_DIR/budget-allowance.md"

echo "✅ Copied plugin files to $PLUGINS_DIR"
echo "✅ Copied slash command to $COMMAND_DIR"

CONFIG_FILE="$CONFIG_DIR/opencode.json"
if [ ! -f "$CONFIG_FILE" ] && [ -f "$CONFIG_DIR/opencode.jsonc" ]; then
  CONFIG_FILE="$CONFIG_DIR/opencode.jsonc"
fi

PLUGIN_ABS_PATH="$PLUGINS_DIR/budget.ts"

node -e "
const fs = require('fs');
const path = '$CONFIG_FILE';
let content = {};
if (fs.existsSync(path)) {
  try { content = JSON.parse(fs.readFileSync(path, 'utf8')); } catch(e){}
}
content['\$schema'] = content['\$schema'] || 'https://opencode.ai/config.json';
content.plugin = content.plugin || [];

const pluginPath = '$PLUGIN_ABS_PATH';
const hasPlugin = content.plugin.some(p => (Array.isArray(p) ? p[0] : p) === pluginPath);

if (!hasPlugin) {
  content.plugin.push([pluginPath, {
    compactAtInputTokens: 120000,
    modelCostBudgets: { 'fable-5': 10.00, 'deepseek-v4': 15.00, 'kimi-k3': 20.00, 'grok-4.5': 25.00 }
  }]);
  fs.writeFileSync(path, JSON.stringify(content, null, 2));
  console.log('✅ Auto-patched ' + path + ' with opencode-budget-allowance plugin!');
} else {
  console.log('ℹ️ Plugin entry already exists in ' + path);
}
"

echo ""
echo "🎉 opencode-budget-allowance installation complete!"
echo "No budget limits are set by default."
echo "To set a session or daily limit, run: /budget-allowance 15 (or run 'bun run ~/.config/opencode/plugins/cli.ts')"
