# opencode-budget-allowance

[![GitHub Repository](https://img.shields.io/badge/GitHub-hithismani%2Fopencode--budget--allowance-blue)](https://github.com/hithismani/opencode-budget-allowance)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Standalone session, daily, project, and provider budget allowance plugin & **100% Offline Interactive CLI** for **opencode** created by [@hithismani](https://github.com/hithismani).

---

## ❌ The Problem

1. **Runaway LLM API Bills:** Working with high-capacity models (Claude 3.5 Opus, GPT-4o, FABLE 5) in multi-turn agent loops can quietly consume tens or hundreds of dollars in API credits within a single session.
2. **The "Override Loop" Trap:** Typical budget plugins throw hard error blocks when a cap is hit. But because your prompt to "raise the budget" also gets blocked by the error, you're locked out from talking to opencode until you hunt down and edit obscure config files manually!
3. **TUI Output Corruption:** Printing raw `console.log()` banners or ASCII boxes into the terminal stdout messes up opencode's TUI renderer, causing garbled borders, line wrap glitches, and visual text artifacts.
4. **Token-Burning Budget Managers:** Using LLM prompts to calculate token prices or ask budget questions burns expensive API tokens just to check or adjust a local setting!

---

## ✅ The Solution: `opencode-budget-allowance`

`opencode-budget-allowance` solves all four problems with a zero-guesswork, native architecture:

* **0-Token Overhead Engine:** Reads opencode's native SQLite database (`~/.local/share/opencode/opencode.db`) directly in non-blocking WAL mode ($< 1\text{ms}$ query latency) with zero external network calls.
* **Smart Prompt Bypassing:** When a limit is hit, prompts containing `budget-allowance`, `/budget`, `override`, `disable budget`, or `off` **bypass budget blocking**, letting you seamlessly talk to opencode to adjust caps!
* **Zero TUI Artifacts (Silent Execution):** Runs 100% silently in the background without stdout line wrap bugs. Active budget status is injected cleanly into the system prompt context array via `experimental.chat.system.transform`.
* **Proactive 90% Toast Warnings:** Injects subtle system warnings when you cross 90% of an active budget so you're never caught off guard.
* **100% Offline Terminal CLI:** Includes an offline CLI tool (`bun run src/cli.ts`) that lets you view spend, lock caps, or update the plugin with 0 LLM tokens burned.

---

## 🎯 Flexible Allowance Scopes (Project, Provider, Model, & Daily)

### 1. Project-Specific Allowances
Because opencode deep-merges project config over global config, you can place an `opencode.json` inside any project directory to set custom project allowances:

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

### 2. Provider-Specific Allowances
Set custom allowance caps per LLM provider (e.g. higher caps for Anthropic, lower for Google Vertex):

```json
"providerCostBudgets": {
  "anthropic": 20.00,
  "google-vertex": 5.00,
  "openai": 10.00
}
```

### 3. Model-Specific Allowances
Set custom allowance caps per model ID or keyword (e.g. `fable-5`, `claude-3-opus`):

```json
"modelCostBudgets": {
  "fable-5": 10.00,
  "claude-3-opus": 15.00
}
```

---

## 💻 Offline Interactive CLI (0 LLM Tokens Burned)

In addition to the opencode slash command, this plugin includes an interactive offline CLI tool:

```bash
# Run the interactive offline CLI anytime from terminal:
bun run /path/to/opencode-budget-allowance/src/cli.ts
```

```text
================================================================
💳 OPENCODE BUDGET ALLOWANCE CLI (100% Offline - 0 LLM Tokens Burned)
================================================================

📊 Today's Spend Overview (2026-08-18):
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

---

## ⚡ Slash Command (`/budget-allowance`)

| Command | Action |
| :--- | :--- |
| **`/budget-allowance`** | View active session spend, daily allowance totals, model burn rate, and token averages. |
| **`/budget-allowance 15`** | Set a **$15.00 allowance cap** on the active chat session. |
| **`/budget-allowance 500k`** | Set a **500,000 token ceiling** on the active chat session. |
| **`/budget-allowance off`** | **Disable budget limits completely** for the active chat session. |
| **`/budget-allowance daily 25`** | Set global **daily budget allowance** to $25.00. |
| **`/budget-allowance history`** | View **audit log history** of past top-ups and allowance changes. |

---

## 🚀 Installation & Setup

### Option A: Global Setup (All Projects)

Copy the plugin & command files into your global opencode config:

```bash
mkdir -p ~/.config/opencode/plugins ~/.config/opencode/command

cp /path/to/opencode-budget-allowance/src/budget.ts ~/.config/opencode/plugins/budget.ts
cp /path/to/opencode-budget-allowance/command/budget-allowance.md ~/.config/opencode/command/budget-allowance.md
```

Then configure `~/.config/opencode/opencode.json` (or `~/.config/opencode/opencode.jsonc`):

> ⚠️ **Important:** Use the **absolute path** to `plugins/budget.ts` in global config files so path resolution works regardless of which project folder you run opencode from!

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["/home/YOUR_USERNAME/.config/opencode/plugins/budget.ts", {
      "defaultDailyLimitUSD": 20.00,
      "compactAtInputTokens": 100000,
      "providerCostBudgets": {
        "anthropic": 20.00,
        "google-vertex": 5.00
      },
      "modelCostBudgets": {
        "fable-5": 10.00,
        "claude-3-opus": 15.00
      }
    }]
  ]
}
```

### Option B: Project Drop-In Auto-Discovery

Copy `src/budget.ts` into any project's `.opencode/plugins/` directory and `command/budget-allowance.md` into `.opencode/command/`. Opencode automatically discovers and loads files in `.opencode/plugins/` on startup without editing any JSON files!

---

## 📁 Overrides & Audit Log File

Active overrides and top-up audit histories are saved at:
`~/.config/opencode/budget-overrides.json`

---

## ⚠️ Disclaimer & Warranty Notice

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.** 

This plugin relies on the cost estimates and token metrics logged by opencode in its local SQLite database. Actual API provider billing (Anthropic, OpenAI, Vertex AI, OpenRouter, etc.) may vary based on provider discounts, cache rates, or latency. Always monitor your LLM provider dashboards directly.

---

## 📜 License

Distributed under the [MIT License](LICENSE).
