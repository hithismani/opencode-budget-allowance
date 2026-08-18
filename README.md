# opencode-budget-allowance (☢ Experimental)

[![GitHub Repository](https://img.shields.io/badge/GitHub-hithismani%2Fopencode--budget--allowance-blue)](https://github.com/hithismani/opencode-budget-allowance)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A session, daily, project, and provider budget allowance plugin and offline interactive CLI for opencode by [@hithismani](https://github.com/hithismani).

## Installation

Run this command in your terminal to copy the files to `~/.config/opencode/` and update your global `~/.config/opencode/opencode.json`:

```bash
curl -sSL https://raw.githubusercontent.com/hithismani/opencode-budget-allowance/main/install.sh | bash
```

Or clone the repository and run the install script locally:

```bash
git clone https://github.com/hithismani/opencode-budget-allowance.git
cd opencode-budget-allowance
./install.sh
```

The installer sets no budget caps by default. When first installed, all sessions and models run without limits. You set caps yourself through the slash command or the config file.

## Why this exists

Working with models like Fable 5, DeepSeek V4, Kimi K3, or Grok 4.5 in agentic loops can consume large amounts of API credits quickly. Most budget plugins throw hard errors when a limit is reached, but because your prompt to change or disable the limit also triggers the same error, you get locked out until you manually edit configuration files. 

Other plugins print console banners directly into stdout, which breaks opencode's TUI layout and causes line wrap bugs. Some plugins even send LLM calls just to calculate token prices, wasting API credits to check a local setting.

## How it works

This plugin addresses those issues:

* It reads opencode's SQLite database (`~/.local/share/opencode/opencode.db`) directly in read-only mode. Reads take under 1ms and require no network requests or pricing table maintenance.
* Prompts containing `budget`, `allowance`, `override`, `disable budget`, or `/budget` bypass tool blocking so you can adjust caps even when a limit is active.
* It runs quietly without console output. Active budget state is passed directly into the system prompt context array via `experimental.chat.system.transform`.
* It injects a warning into the system prompt when you cross 90% of an active allowance.
* It includes an offline CLI script (`bun run src/cli.ts`) so you can inspect spend and set caps without calling an LLM.

## Setting allowances

No budgets are set on install. You control when and how limits apply.

### 1. Slash command (`/budget`)

Run `/budget` directly in your opencode chat session:

* `/budget`: Show current session spend, daily totals, and active limits.
* `/budget 15`: Set a $15.00 limit for the active chat session.
* `/budget 500k`: Set a 500,000 token limit for the active chat session.
* `/budget off`: Disable budget checks for the active chat session.
* `/budget off global`: Disable budget checks for all sessions.
* `/budget on` / `/budget on global`: Re-enable session or global checks.
* `/budget daily 25`: Set the global daily cost allowance to $25.00.
* `/budget history`: Show the audit log of past top-ups.

### 2. Project-specific allowances

Because opencode merges project configuration over global configuration, you can add an `opencode.json` inside a project folder to set local caps:

```json
{
  "plugin": [
    ["/abs/path/to/opencode-budget-allowance/src/budget.ts", {
      "defaultDailyLimitUSD": 15.00,
      "defaultSessionLimitUSD": 5.00
    }]
  ]
}
```

### 3. Provider-specific allowances

You can set cost caps per provider in `opencode.json`:

```json
"providerCostBudgets": {
  "anthropic": 20.00,
  "google-vertex": 5.00,
  "xai": 10.00
}
```

### 4. Provider-specific model allowances

You can set caps for specific models under specific providers in two convenient ways:

**Option A: Provider-prefixed model keys**
```json
"modelCostBudgets": {
  "anthropic/claude-3-7-sonnet": 10.00,
  "google-vertex/gemini-2.5-pro": 5.00,
  "xai/grok-4.5": 15.00
}
```

**Option B: Nested `providerModelCostBudgets`**
```json
"providerModelCostBudgets": {
  "anthropic": {
    "claude-3-7-sonnet": 10.00,
    "claude-3-5-haiku": 2.00
  },
  "google-vertex": {
    "gemini-2.5-pro": 5.00
  }
}
```

### 5. Generic model allowances

Token ceilings use the same shapes via `modelTokenBudgets`, `providerTokenBudgets`, and `providerModelTokenBudgets`.

You can also set global caps for specific models across any provider:

```json
"modelCostBudgets": {
  "fable-5": 10.00,
  "deepseek-v4": 15.00,
  "kimi-k3": 20.00,
  "grok-4.5": 25.00
}
```

## Offline interactive CLI

You can manage budgets without using LLM tokens by running the terminal CLI:

```bash
bun run /path/to/opencode-budget-allowance/src/cli.ts
```

```text
================================================================
OPENCODE BUDGET ALLOWANCE CLI (100% Offline - 0 LLM Tokens Burned)
================================================================

Today's Spend Overview (2026-08-18):
   • Total Cost Spent:       $7.90
   • Total Tokens Used:      3,633,942
   • Active Sessions Today:  2
   • Avg Cost / Session:     $3.95

Select an option:
  1) Set / Top-Up Daily Budget Limit
  2) Set Budget Cap for a Session
  3) Disable / Re-enable Budget Checks for a Session
  4) Toggle Global Budget Checks (All Sessions)
  5) View Top-Up Audit History Log
  6) Update Plugin & Slash Command (git pull & sync)
  7) Exit
```

## Database metrics

Opencode calculates token counts and costs on every turn and writes them to SQLite:

* Database path: `~/.local/share/opencode/opencode.db`
* Table: `session`

The plugin queries `cost`, `tokens_input`, `tokens_output`, `tokens_cache_read`, and `tokens_cache_write` from this table.

## Local state and overrides

Active overrides and top-up audit records are stored at `~/.config/opencode/budget-overrides.json`. To reset all overrides manually, edit or delete that file.

## Disclaimer

This software is provided as is, without warranty of any kind. This plugin relies on cost estimates logged by opencode in its local SQLite database. Actual provider billing may vary based on cache rates, discounts, or API changes. Monitor your provider dashboards directly.

## License

Distributed under the [MIT License](LICENSE).
