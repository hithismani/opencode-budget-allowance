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
   - "daily <amount>" (e.g. "daily 25", "daily 2m"): Set or top up today's daily allowance using `budget_set_limit` (with scope: "daily") or `bun run ~/.config/opencode/plugins/cli.ts daily <amount>`.
   - "<amount>" (e.g. "15", "500k"): Set a budget limit for the active session using `budget_set_limit` (with scope: "session") or `bun run ~/.config/opencode/plugins/cli.ts <amount>`.
   - "history": Show top-up audit history log.
   - Confirm the change concisely to the user.

2. If NO arguments are provided:
   - Check current spend using `budget_get_status` (or `bun run ~/.config/opencode/plugins/cli.ts status`).
   - Display today's spend summary, active session limits, and global budget status.
   - Ask the user if they'd like to set a session cap (e.g. $10 or 500k tokens), a daily allowance top-up, or disable limits (session or global).
   - Remind the user they can also run `bun run ~/.config/opencode/plugins/cli.ts` in terminal for the offline interactive menu.

CRITICAL RULES:
- DO NOT read, edit, or modify any codebase or files. This is strictly a budget management command.
