---
description: Your AI Budget Allowance — manage session budget (/budget-allowance 10), token ceilings (/budget-allowance 500k), daily limits (/budget-allowance daily 20), disable caps (/budget-allowance off), or view history (/budget-allowance history)
agent: build
---

Process the `/budget-allowance` command argument "$ARGUMENTS":
- If $ARGUMENTS is empty or "status": Display current active session spend, daily budget allowance, model burn rate, and token averages.
- If $ARGUMENTS is "off", "disable", or "unlimited": Disable budget enforcement for the current session completely.
- If $ARGUMENTS starts with "daily": Set the daily global cost budget allowance to the specified dollar amount (e.g. `/budget-allowance daily 20`).
- If $ARGUMENTS ends with "k" or "m" or "tokens": Set the session token ceiling (e.g. `/budget-allowance 500k`).
- If $ARGUMENTS is "history" or "audit": Display the full audit log history of all past top-ups and allowance changes.
- Otherwise, treat $ARGUMENTS as a numeric dollar amount to set as the active session budget allowance (e.g. `/budget-allowance 10` sets $10 allowance).
