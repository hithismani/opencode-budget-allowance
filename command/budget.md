---
description: Check spend metrics, allocate budgets, or set session/daily/global caps
---

User arguments: "$ARGUMENTS"

Instructions:
1. If arguments are provided:
   - "off global" or "global off": Disable budget checks globally for all sessions using the `budget_disable` tool (with scope: "global") or by running `bun run ~/.config/opencode/plugins/cli.ts off global`.
   - "on global" or "global on": Re-enable budget checks globally using the `budget_enable` tool (with scope: "global") or by running `bun run ~/.config/opencode/plugins/cli.ts on global`.
   - "off": Disable budget checks for the active session using `budget_disable` (with scope: "session") or `bun run ~/.config/opencode/plugins/cli.ts off`.
   - "on": Re-enable budget checks for the active session using `budget_enable` (with scope: "session") or `bun run ~/.config/opencode/plugins/cli.ts on`.
   - "daily <amount>" (e.g. "daily 25", "daily 2m", "daily +10"): Set or top up today's daily allowance using `budget_set_limit` (with scope: "daily", mode: "set" or "topup") or `bun run ~/.config/opencode/plugins/cli.ts daily <amount>`.
   - "<amount>" (e.g. "15", "500k"): Set a budget limit for the active session using `budget_set_limit` (with scope: "session") or `bun run ~/.config/opencode/plugins/cli.ts <amount>`.
   - "history": Show top-up audit history log using the `budget_get_history` tool (or `bun run ~/.config/opencode/plugins/cli.ts history`).
   - Always confirm the change with the current spend, new cap, and remaining/pending allowance.

2. If NO arguments are provided or the user asks about usage / spend / balance:
   - Check current spend and limits using `budget_get_status` (or `bun run ~/.config/opencode/plugins/cli.ts status`).
   - Clearly present:
     • **Active Session**: Cost spent so far, tokens used, session cap, and remaining/pending balance.
     • **Today's Total**: Cost spent across all sessions today, token count, daily cap (if set), and remaining daily allowance.
   - Offer quick options to adjust session caps, daily allowances, or toggle checks.
   - Remind the user they can also run `bun run ~/.config/opencode/plugins/cli.ts` in terminal for the 100% offline interactive menu.

CRITICAL RULES:
- DO NOT read, edit, or modify any codebase or files. This is strictly a budget management command.
