#!/usr/bin/env bash
set -e

CONFIG_DIR="$HOME/.config/opencode"
PLUGINS_DIR="$CONFIG_DIR/plugins"
COMMAND_DIR="$CONFIG_DIR/command"
COMMANDS_DIR="$CONFIG_DIR/commands"

mkdir -p "$PLUGINS_DIR" "$COMMAND_DIR" "$COMMANDS_DIR"

# Always clean up managed files and deprecated command names
rm -f "$PLUGINS_DIR/budget.ts" "$PLUGINS_DIR/cli.ts"
rm -f "$COMMAND_DIR/budget-allowance.md" "$COMMAND_DIR/allocate-budget.md" "$COMMAND_DIR/budget.md"
rm -f "$COMMANDS_DIR/budget-allowance.md" "$COMMANDS_DIR/allocate-budget.md" "$COMMANDS_DIR/budget.md"

REPO_RAW="https://raw.githubusercontent.com/hithismani/opencode-budget-allowance/main"

# When run from a clone, files live next to this script. When piped via
# curl | bash, BASH_SOURCE resolves to the caller's cwd, so detect that and
# download the files from GitHub instead of cp-ing from a nonexistent path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"

if [ -f "$SCRIPT_DIR/src/budget.ts" ]; then
  # Running from a clone: pull latest first so a reinstall never copies stale code.
  if [ -d "$SCRIPT_DIR/.git" ]; then
    echo "🔄 Pulling latest changes in local clone..."
    if ! git -C "$SCRIPT_DIR" pull --ff-only -q 2>/dev/null; then
      echo "⚠️  git pull failed — continuing with local files as-is."
    fi
  fi
  SRC_DIR="$SCRIPT_DIR"
  echo "📦 Installing from local clone: $SRC_DIR"
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  mkdir -p "$TMP_DIR/src" "$TMP_DIR/command"
  echo "⬇️  Downloading plugin files from GitHub..."
  curl -fsSL "$REPO_RAW/src/budget.ts" -o "$TMP_DIR/src/budget.ts"
  curl -fsSL "$REPO_RAW/src/cli.ts" -o "$TMP_DIR/src/cli.ts"
  curl -fsSL "$REPO_RAW/command/budget.md" -o "$TMP_DIR/command/budget.md"
  SRC_DIR="$TMP_DIR"
fi

cp "$SRC_DIR/src/budget.ts" "$PLUGINS_DIR/budget.ts"
cp "$SRC_DIR/src/cli.ts" "$PLUGINS_DIR/cli.ts"

if [ -f "$SRC_DIR/command/budget.md" ]; then
  cp "$SRC_DIR/command/budget.md" "$COMMAND_DIR/budget.md"
  cp "$SRC_DIR/command/budget.md" "$COMMANDS_DIR/budget.md"
fi

echo "✅ Copied plugin files to $PLUGINS_DIR"
echo "✅ Copied slash command (/budget) to $COMMAND_DIR and $COMMANDS_DIR"

PLUGIN_ABS_PATH="$PLUGINS_DIR/budget.ts"

patch_config() {
  local file="$1"
  node -e "
const fs = require('fs');
const path = '$file';
let content = {};
if (fs.existsSync(path)) {
  try { content = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) {
    // Never rewrite a file we can't parse (e.g. jsonc with comments) —
    // that would destroy the user's config.
    console.log('⚠️  Skipping ' + path + ' (not strict JSON — edit it manually if needed)');
    process.exit(0);
  }
}
content = content || {};
content['\$schema'] = content['\$schema'] || 'https://opencode.ai/config.json';
content.plugin = content.plugin || [];

const pluginPath = '$PLUGIN_ABS_PATH';
const hasPlugin = content.plugin.some(p => (Array.isArray(p) ? p[0] : p) === pluginPath);

if (!hasPlugin) {
  content.plugin.push([pluginPath, {}]);
}
fs.writeFileSync(path, JSON.stringify(content, null, 2));
console.log('✅ Patched ' + path + ' (no budget caps set)');
"
}

PATCHED=0
if [ -f "$CONFIG_DIR/opencode.json" ]; then
  patch_config "$CONFIG_DIR/opencode.json"
  PATCHED=1
fi
if [ -f "$CONFIG_DIR/opencode.jsonc" ]; then
  patch_config "$CONFIG_DIR/opencode.jsonc"
  PATCHED=1
fi
if [ "$PATCHED" = "0" ]; then
  patch_config "$CONFIG_DIR/opencode.json"
fi

echo ""
echo "🎉 opencode-budget-allowance installation complete!"
echo "No budget limits are set by default."
echo "Restart opencode to load the updated plugin and /budget command."
echo "In chat: run /budget (or /budget 15, /budget off, /budget off global)"
echo "In terminal: run 'bun run ~/.config/opencode/plugins/cli.ts' for offline interactive menu"
