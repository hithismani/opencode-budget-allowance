---
description: Manage session budget (/budget-allowance 10), token ceilings (/budget-allowance 500k), daily limits (/budget-allowance daily 20), disable caps (/budget-allowance off), or view history (/budget-allowance history)
agent: build
---

Input argument: "$ARGUMENTS"

Instructions:
1. If the input argument above is empty or "status":
   - Read local budget state file at ~/.config/opencode/budget-overrides.json.
   - Query SQLite database at ~/.local/share/opencode/opencode.db for current session cost, tokens_input, tokens_output, and today's total spend.
   - Display a concise report showing: Current Session Spend, Session Cap, Today's Total Spend, Daily Budget Limit, and Token Averages.

2. If the input argument is "off", "disable", or "unlimited":
   - Add the current session ID to disabledSessions in ~/.config/opencode/budget-overrides.json.
   - Confirm to the user that budget checks are disabled for this chat session.

3. If the input argument starts with "daily":
   - Parse the numeric dollar amount after "daily" (e.g., "daily 20" -> $20.00).
   - Update dailyTopUpUSD for today's date in ~/.config/opencode/budget-overrides.json.
   - Confirm the new daily budget limit to the user.

4. If the input argument ends with "k" or "m" or "tokens":
   - Parse the token number (e.g., "500k" -> 500,000).
   - Set sessionTokenLimits for the active session in ~/.config/opencode/budget-overrides.json.
   - Confirm the new token ceiling to the user.

5. If the input argument is "history" or "audit":
   - Read history array from ~/.config/opencode/budget-overrides.json.
   - Display the recent audit log of all top-ups and overrides.

6. Otherwise, if the input argument is a number (e.g., "10" or "15.50"):
   - Set sessionCostLimits for the active session ID in ~/.config/opencode/budget-overrides.json.
   - Confirm the new session budget allowance limit to the user.
