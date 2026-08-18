#!/usr/bin/env node

import readline from "readline";
import { execSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import { loadState, saveState, getOverviewMetrics } from "./budget.ts";

// ============================================================================
// READLINE PROMPT HELPER
// ============================================================================

function ask(rl: readline.Interface, questionText: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(questionText, (ans) => {
      resolve(ans.trim());
    });
  });
}

// ============================================================================
// CLI WRAPPER AROUND TS BUDGET ENGINE
// ============================================================================

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const state = loadState();
  const metrics = getOverviewMetrics();
  const todayStr = new Date().toISOString().split("T")[0];

  console.clear();
  console.log(`\x1b[1m\x1b[36m================================================================\x1b[0m`);
  console.log(`💳 \x1b[1mOPENCODE BUDGET ALLOWANCE CLI\x1b[0m \x1b[2m(100% Offline - 0 LLM Tokens Burned)\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m================================================================\x1b[0m\n`);

  console.log(`📊 \x1b[1mToday's Spend Overview (${todayStr}):\x1b[0m`);
  console.log(`   • Total Cost Spent:       \x1b[32m$${metrics.dailyCost.toFixed(2)}\x1b[0m`);
  console.log(`   • Total Tokens Used:      \x1b[33m${metrics.dailyTokens.toLocaleString()}\x1b[0m`);
  console.log(`   • Active Sessions Today:  ${metrics.sessionCount}`);
  console.log(`   • Avg Cost / Session:     $${metrics.avgCost.toFixed(2)}\n`);

  console.log(`\x1b[1mSelect an option:\x1b[0m`);
  console.log(`  \x1b[36m1)\x1b[0m Set Daily Budget Limit`);
  console.log(`  \x1b[36m2)\x1b[0m Set Budget Cap for a Session`);
  console.log(`  \x1b[36m3)\x1b[0m Disable Budget Checks for a Session`);
  console.log(`  \x1b[36m4)\x1b[0m View Top-Up Audit History Log`);
  console.log(`  \x1b[36m5)\x1b[0m Update Plugin & Commands (git pull & sync)`);
  console.log(`  \x1b[36m6)\x1b[0m Exit\n`);

  const choice = await ask(rl, `\x1b[1mEnter choice [1-6]: \x1b[0m`);

  if (choice === "1") {
    const amountStr = await ask(rl, `Enter extra daily dollar top-up (e.g. 10.00): $`);
    const amount = parseFloat(amountStr);
    if (!isNaN(amount) && amount > 0) {
      state.dailyTopUpUSD[todayStr] = (state.dailyTopUpUSD[todayStr] || 0) + amount;
      state.history.push({
        id: `cli_${Date.now()}`,
        timestamp: Date.now(),
        dateStr: todayStr,
        sessionId: "GLOBAL_DAILY",
        model: "CLI_MANUAL",
        scope: "daily",
        type: "cost",
        amount,
      });
      saveState(state);
      console.log(`\n\x1b[32m✅ Added +$${amount.toFixed(2)} to daily budget allowance!\x1b[0m\n`);
    } else {
      console.log(`\n❌ Invalid dollar amount.\n`);
    }
  } else if (choice === "2") {
    if (metrics.sessions.length === 0) {
      console.log(`\n⚠️ No recent sessions found in SQLite database.\n`);
    } else {
      console.log(`\n\x1b[1mRecent Sessions:\x1b[0m`);
      metrics.sessions.forEach((s, idx) => {
        console.log(`  \x1b[36m${idx + 1})\x1b[0m [${s.id}] ${s.title || "Untitled"} ($${s.cost.toFixed(2)})`);
      });

      const idxStr = await ask(rl, `\nSelect session number [1-${metrics.sessions.length}]: `);
      const idx = parseInt(idxStr, 10) - 1;

      if (idx >= 0 && idx < metrics.sessions.length) {
        const targetSession = metrics.sessions[idx];
        const capStr = await ask(rl, `Enter budget limit cap for "${targetSession.title || targetSession.id}": $`);
        const cap = parseFloat(capStr);

        if (!isNaN(cap) && cap > 0) {
          state.sessionCostLimits[targetSession.id] = { limit: cap, model: "CLI_MANUAL" };
          delete state.disabledSessions[targetSession.id];
          saveState(state);
          console.log(`\n\x1b[32m✅ Locked session allowance cap at $${cap.toFixed(2)}!\x1b[0m\n`);
        } else {
          console.log(`\n❌ Invalid cap amount.\n`);
        }
      }
    }
  } else if (choice === "3") {
    if (metrics.sessions.length === 0) {
      console.log(`\n⚠️ No recent sessions found in SQLite database.\n`);
    } else {
      console.log(`\n\x1b[1mRecent Sessions:\x1b[0m`);
      metrics.sessions.forEach((s, idx) => {
        const status = state.disabledSessions[s.id] ? "\x1b[31m[Disabled]\x1b[0m" : "\x1b[32m[Active]\x1b[0m";
        console.log(`  \x1b[36m${idx + 1})\x1b[0m [${s.id}] ${s.title || "Untitled"} ${status}`);
      });

      const idxStr = await ask(rl, `\nSelect session number to disable budget [1-${metrics.sessions.length}]: `);
      const idx = parseInt(idxStr, 10) - 1;

      if (idx >= 0 && idx < metrics.sessions.length) {
        const targetSession = metrics.sessions[idx];
        state.disabledSessions[targetSession.id] = true;
        saveState(state);
        console.log(`\n\x1b[32m✅ Disabled budget checks for session ${targetSession.id}!\x1b[0m\n`);
      }
    }
  } else if (choice === "4") {
    console.log(`\n\x1b[1mTop-Up Audit History Log:\x1b[0m`);
    if (state.history.length === 0) {
      console.log(`  (No top-up records found)`);
    } else {
      state.history.slice(-10).reverse().forEach((rec) => {
        const date = new Date(rec.timestamp).toLocaleString();
        console.log(`  • [${date}] Scope: ${rec.scope} | Type: ${rec.type} | Amount: $${rec.amount.toFixed(2)} | Session: ${rec.sessionId}`);
      });
    }
    console.log("");
  } else if (choice === "5") {
    console.log(`\n🔄 Updating opencode-budget-allowance plugin...`);
    try {
      const repoDir = path.resolve(path.dirname(import.meta.url.replace("file://", "")), "..");
      if (fs.existsSync(path.join(repoDir, ".git"))) {
        execSync("git pull origin main", { cwd: repoDir, stdio: "inherit" });
      }

      const globalPluginPath = path.join(os.homedir(), ".config/opencode/plugins/budget.ts");
      const globalCmdPath = path.join(os.homedir(), ".config/opencode/command/budget-allowance.md");

      fs.mkdirSync(path.dirname(globalPluginPath), { recursive: true });
      fs.mkdirSync(path.dirname(globalCmdPath), { recursive: true });

      fs.copyFileSync(path.join(repoDir, "src/budget.ts"), globalPluginPath);
      fs.copyFileSync(path.join(repoDir, "command/budget-allowance.md"), globalCmdPath);

      console.log(`\x1b[32m✅ Plugin and slash commands updated successfully to ~/.config/opencode/!\x1b[0m\n`);
    } catch (err: any) {
      console.error(`❌ Update failed: ${err.message}\n`);
    }
  }

  rl.close();
}

main().catch(console.error);
