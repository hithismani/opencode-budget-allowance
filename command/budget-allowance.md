---
description: Manage session budget via the offline CLI (top-ups, caps, disable, history)
agent: build
---

Input argument: "$ARGUMENTS"

Instructions:
Run the offline budget CLI script with the given arguments. It is a fully offline
interactive terminal tool that reads/writes the budget state directly — no LLM
tokens are used to manage budgets.

```
bun run ~/.config/opencode/plugins/cli.ts $ARGUMENTS
```

Run it with stdio inherited so the user can interact with the menu directly.
Do not paraphrase, summarize, or re-implement what the CLI does — just run it
and let the user use the tool.
