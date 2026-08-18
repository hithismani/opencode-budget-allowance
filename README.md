# opencode-budget-allowance

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

Working with models like Claude 3.5 Opus, GPT-4o, or FABLE 5 in agentic loops can consume large amounts of API credits quickly. Most budget plugins throw hard errors when a limit is reached, but because your prompt to change or disable the limit also triggers the same error, you get locked out until you manually edit configuration files. 

Other plugins print console banners directly into stdout, which breaks opencode's TUI layout and causes line wrap bugs. Some plugins even send LLM calls just to calculate token prices, wasting API credits to check a local setting.

## How it works

This plugin addresses those issues:

* It reads opencode's SQLite database (`~/.local/share/opencode/opencode.db`) directly in read-only WAL mode. Reads take under 1ms and require no network requests or pricing table maintenance.
* Prompts containing `budget-allowance`, `/budget`, `override`, `disable budget`, or `off` bypass budget blocking. You can talk to opencode to adjust caps even when a limit is active.
* It runs quietly without console output. Active budget state is passed directly into the system prompt context array via `experimental.chat.system.transform`.
* It injects a warning into the system prompt when you cross 90% of an active allowance.
* It includes an offline CLI script (`bun run src/cli.ts`) so you can inspect spend and set caps without calling an LLM.

## Setting allowances

No budgets are set on install. You control when and how limits apply.

### 1. Slash command (`/budget-allowance`)

Run the `/budget-allowance` command directly in your opencode session:

* `/budget-allowance`: Show current session spend, daily totals, and average token usage.
* `/budget-allowance 15`: Set a $15.00 limit for the active chat session.
* `/budget-allowance 500k`: Set a 500,000 token limit for the active chat session.
* `/budget-allowance off`: Disable budget checks for the active chat session.
* `/budget-allowance daily 25`: Set the global daily cost allowance to $25.00.
* `/budget-allowance history`: Show the audit log of past top-ups.

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
  "openai": 10.00
}
```

### 4. Model-specific allowances

You can also set caps for specific models or keywords:

```json
"modelCostBudgets": {
  "fable-5": 10.00,
  "claude-3-opus": 15.00
}
```

When a model is available across multiple providers (such as `claude-3-5-sonnet` on Anthropic vs Google Vertex), `modelCostBudgets` caps total session spend regardless of provider, while `providerCostBudgets` tracks costs against the active provider's specific limit.

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
  1) Set Daily Budget Limit
  2) Set Budget Cap for a Session
  3) Disable Budget Checks for a Session
  4) View Top-Up Audit History Log
  5) Update Plugin & Commands (git pull & sync)
  6) Exit
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
