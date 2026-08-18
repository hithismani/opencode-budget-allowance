# opencode-budget-allowance

[![GitHub Repository](https://img.shields.io/badge/GitHub-hithismani%2Fopencode--budget--allowance-blue)](https://github.com/hithismani/opencode-budget-allowance)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Standalone session and daily budget allowance plugin & **100% Offline Interactive CLI** for **opencode** created by [@hithismani](https://github.com/hithismani).

---

## 💻 Offline Interactive CLI (0 LLM Tokens Burned)

In addition to the opencode slash command, this plugin includes a **100% offline terminal CLI tool** (`bun run src/cli.ts` or `npx budget-allowance`).

You can check your spending stats, set daily/session limits, or disable budgets **without calling any LLMs or burning a single API token!**

```bash
# Run the interactive offline CLI anytime from terminal:
bun run /path/to/opencode-budget-allowance/src/cli.ts
```

```text
================================================================
💳 OPENCODE BUDGET ALLOWANCE CLI (100% Offline - 0 LLM Tokens Burned)
================================================================

📊 Today's Spend Overview (2026-08-18):
   • Total Cost Spent:       $6.82
   • Total Tokens Used:      3,165,459
   • Active Sessions Today:  2
   • Avg Cost / Session:     $3.41

Select an option:
  1) Set Daily Budget Limit
  2) Set Budget Cap for a Session
  3) Disable Budget Checks for a Session
  4) View Top-Up Audit History Log
  5) Exit
```

---

## 🏛️ How Costing & Token Tracking Works (Native Opencode SQLite Engine)

**Important:** This plugin **does NOT calculate token prices, parse model pricing tables, or guess token usage manually**. 

Opencode **natively calculates exact token counts and $ USD costs on every turn** and records them directly into its native SQLite database:

📍 **Database Path:** `~/.local/share/opencode/opencode.db`  
📊 **Table:** `session`

```sql
SELECT 
  cost,                -- Native $ USD cost calculated per turn by Opencode
  tokens_input,        -- Input prompt tokens
  tokens_output,       -- Generated output tokens
  tokens_cache_read,   -- Prompt cache hits
  tokens_cache_write   -- Prompt cache writes
FROM session WHERE id = ?
```

### Why This Architecture Is Rock-Solid:
* **Zero Latency Overhead:** Reads directly from SQLite in non-blocking WAL mode ($< 1\text{ms}$ query latency).
* **Single Source of Truth:** Operates on the exact same ground-truth numbers that opencode tracks natively.
* **No Pricing Maintenance:** Never worry about updating model rates or tokenizers when provider prices change.

---

## 🌟 Key Features

* **Zero Token Burn CLI:** Use the standalone terminal CLI to view stats and manage limits offline with 0 LLM tokens burned.
* **Default Behavior on Install:** Installs as **Unlimited (`Infinity`)** by default. No unexpected budget blocks happen unless you explicitly set caps in `opencode.json` or via `/budget-allowance`!
* **Override Loop Fix (Prompt Bypassing):** When a limit is hit, prompts containing `budget-allowance`, `/budget`, `override`, `disable budget`, or `off` are **never blocked**, so you can seamlessly talk to opencode to adjust or disable your budget!
* **Zero TUI Artifacts (Silent Execution):** Runs 100% silently without injecting raw `console.log()` text into terminal stdout. System context is injected cleanly via `experimental.chat.system.transform`.
* **Explicit Error Identification:** All error blocks carry the `[OPENCODE BUDGET ALLOWANCE PLUGIN BLOCK]` prefix and cite the exact local overrides file path (`~/.config/opencode/budget-overrides.json`).

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

Then configure `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./plugins/budget.ts", {
      "defaultDailyLimitUSD": 20.00,
      "compactAtInputTokens": 100000,
      "modelCostBudgets": {
        "fable-5": 10.00,
        "claude-3-opus": 15.00
      }
    }]
  ]
}
```

---

## 📁 Overrides & Audit Log File

Active overrides and top-up audit histories are saved at:
`~/.config/opencode/budget-overrides.json`

If you ever want to reset all limits manually, simply delete or edit that file!

---

## ⚠️ Disclaimer & Warranty Notice

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.** 

This plugin relies on the cost estimates and token metrics logged by opencode in its local SQLite database. Actual API provider billing (Anthropic, OpenAI, Vertex AI, OpenRouter, etc.) may vary based on provider discounts, cache rates, or latency. The authors and contributors shall not be held liable for any unexpected API charges, overages, or financial losses resulting from the use or misuse of this software. Always monitor your LLM provider dashboards directly.

---

## 📜 License

Distributed under the [MIT License](LICENSE).
