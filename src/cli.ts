#!/usr/bin/env node

import { execSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import {
  loadState,
  saveState,
  getOverviewMetrics,
  getSessionMetrics,
  getEffectiveDailyLimits,
  formatK,
  type BudgetState,
  type BudgetOptions,
} from "./budget.ts";

// ============================================================================
// TERMINAL INPUT HELPERS
//
// The opencode TUI leaves SGR mouse reporting (ESC [ < b ; x ; y M/m) enabled
// on the pty it spawns CLIs in. Without stripping those sequences, every mouse
// move echoes into the prompt as raw garbage (e.g. "35;35;18M35;36;18M..."),
// flooding the menu input line. So we (1) turn mouse reporting and bracketed
// paste off while the CLI runs, and (2) filter any escape sequences that still
// arrive on stdin before they reach the prompt.
// ============================================================================

const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l";
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h";

// Raw stdin chunks, still containing escape sequences, waiting to be parsed.
let rawQueue = "";
// Cleaned text (escape sequences removed) that arrived but wasn't asked for yet.
let textQueue = "";

// Strip CSI escape sequences (arrows, function keys, SGR mouse events, ...)
// from raw stdin data, keeping sequences split across chunks intact.
function cleanInput(raw: string): string {
  rawQueue += raw;
  let out = "";
  while (rawQueue.length > 0) {
    const esc = rawQueue.indexOf("\x1b");
    if (esc === -1) {
      out += rawQueue;
      rawQueue = "";
      break;
    }
    if (esc > 0) {
      out += rawQueue.slice(0, esc);
      rawQueue = rawQueue.slice(esc);
      continue;
    }
    const complete = rawQueue.match(/^\x1b\[[0-9;?<]*[A-Za-z~]/);
    if (complete) {
      rawQueue = rawQueue.slice(complete[0].length);
      continue;
    }
    // OSC sequences (ESC ] ... BEL or ESC \), e.g. terminal title changes.
    const osc = rawQueue.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);
    if (osc) {
      rawQueue = rawQueue.slice(osc[0].length);
      continue;
    }
    // Prefix of a sequence that may finish in the next chunk — hold it.
    if (/^\x1b\[[0-9;?<]*$/.test(rawQueue) && rawQueue.length < 64) {
      break;
    }
    // Lone ESC or malformed garbage — drop one byte so it can never echo.
    rawQueue = rawQueue.slice(1);
  }
  return out;
}

// Ask for one line of input. Returns once a newline (or Ctrl+D) is seen.
function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  if (!process.stdin.isTTY) {
    // Piped input: lines may already be buffered from an earlier prompt.
    return new Promise((resolve) => {
      const flush = () => {
        const nl = textQueue.indexOf("\n");
        if (nl === -1) return false;
        const line = textQueue.slice(0, nl);
        textQueue = textQueue.slice(nl + 1);
        resolve(line.trim());
        return true;
      };
      if (flush()) {
        process.stdin.pause();
        return;
      }
      const onData = (chunk: string) => {
        textQueue += cleanInput(chunk);
        if (flush()) {
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
        }
      };
      process.stdin.on("data", onData);
      process.stdin.resume();
    });
  }

  return new Promise((resolve) => {
    const wasRaw = (process.stdin as any).isRaw || false;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let line = "";
    let done = false;

    const finish = (value: string) => {
      if (done) return;
      done = true;
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\r\n");
      resolve(value);
    };

    const onData = (chunk: string) => {
      for (const ch of cleanInput(chunk)) {
        if (ch === "\r" || ch === "\n" || ch === "\x04") {
          finish(line.trim());
          return;
        }
        if (ch === "\x7f" || ch === "\b") {
          if (line.length > 0) {
            line = Array.from(line).slice(0, -1).join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch === "\x03") {
          // Ctrl+C: restore the terminal and exit cleanly.
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode(wasRaw);
          process.stdout.write("\r\n");
          process.exit(130);
        }
        if (ch >= " " && ch !== "\x1b") {
          line += ch;
          process.stdout.write(ch);
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function parseAmount(input: string): { type: "cost" | "token"; value: number } | null {
  const clean = input.replace(/^\$/, "").trim().toLowerCase();
  if (/^[0-9]+(\.[0-9]+)?k$/.test(clean)) {
    return { type: "token", value: parseFloat(clean.replace("k", "")) * 1_000 };
  }
  if (/^[0-9]+(\.[0-9]+)?m$/.test(clean)) {
    return { type: "token", value: parseFloat(clean.replace("m", "")) * 1_000_000 };
  }
  if (/^[0-9]+(\.[0-9]+)?b$/.test(clean)) {
    return { type: "token", value: parseFloat(clean.replace("b", "")) * 1_000_000_000 };
  }
  const num = parseFloat(clean);
  if (!isNaN(num) && num > 0) {
    return { type: "cost", value: num };
  }
  return null;
}

function getActiveSession(): { id: string; title?: string } | null {
  if (process.env.OPENCODE_SESSION_ID) {
    return { id: process.env.OPENCODE_SESSION_ID };
  }
  const metrics = getOverviewMetrics();
  if (metrics.sessions && metrics.sessions.length > 0) {
    return { id: metrics.sessions[0].id, title: metrics.sessions[0].title };
  }
  return null;
}

function printStatusOverview(state: BudgetState, metrics: ReturnType<typeof getOverviewMetrics>, todayStr: string) {
  const { effectiveDailyCostLimit, effectiveDailyTokenLimit, dailyTopUpUSD, dailyTopUpTokens } =
    getEffectiveDailyLimits(state, {}, todayStr);

  console.log(`\x1b[1m\x1b[36m================================================================\x1b[0m`);
  console.log(`💳 \x1b[1mOPENCODE BUDGET ALLOWANCE\x1b[0m \x1b[2m(100% Offline - 0 LLM Tokens)\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m================================================================\x1b[0m\n`);

  console.log(`📊 \x1b[1mToday's Spend Overview (${todayStr}):\x1b[0m`);
  console.log(`   • Total Cost Spent:       \x1b[32m$${metrics.dailyCost.toFixed(2)}\x1b[0m`);
  console.log(`   • Total Tokens Used:      \x1b[33m${metrics.dailyTokens.toLocaleString()}\x1b[0m`);
  console.log(`   • Active Sessions Today:  ${metrics.sessionCount}`);
  console.log(`   • Avg Cost / Session:     $${metrics.avgCost.toFixed(2)}\n`);

  console.log(`⚙️  \x1b[1mGlobal / Daily Budget Status:\x1b[0m`);
  if (state.globalDisabled === true) {
    console.log(`   • Status:                 \x1b[31mGLOBALLY DISABLED (all checks bypassed)\x1b[0m`);
  } else {
    console.log(`   • Status:                 \x1b[32mActive (limits enforced)\x1b[0m`);
    if (effectiveDailyCostLimit !== Infinity) {
      const dailyRemaining = Math.max(0, effectiveDailyCostLimit - metrics.dailyCost);
      const dailyPct = effectiveDailyCostLimit > 0 ? ((metrics.dailyCost / effectiveDailyCostLimit) * 100).toFixed(1) : "0.0";
      console.log(`   • Daily Cost Cap:         \x1b[32m$${effectiveDailyCostLimit.toFixed(2)}\x1b[0m (Spent: $${metrics.dailyCost.toFixed(2)} | Remaining: \x1b[36m$${dailyRemaining.toFixed(2)}\x1b[0m | ${dailyPct}% used)`);
    } else {
      console.log(`   • Daily Cost Cap:         None (unlimited)`);
    }

    if (effectiveDailyTokenLimit !== Infinity) {
      const dailyTokensRemaining = Math.max(0, effectiveDailyTokenLimit - metrics.dailyTokens);
      const dailyTokenPct = effectiveDailyTokenLimit > 0 ? ((metrics.dailyTokens / effectiveDailyTokenLimit) * 100).toFixed(1) : "0.0";
      console.log(`   • Daily Token Cap:        \x1b[33m${formatK(effectiveDailyTokenLimit)}\x1b[0m (Used: ${formatK(metrics.dailyTokens)} | Remaining: \x1b[36m${formatK(dailyTokensRemaining)}\x1b[0m | ${dailyTokenPct}% used)`);
    } else {
      console.log(`   • Daily Token Cap:        None (unlimited)`);
    }

    if (dailyTopUpUSD > 0 || dailyTopUpTokens > 0) {
      const topUps: string[] = [];
      if (dailyTopUpUSD > 0) topUps.push(`+$${dailyTopUpUSD.toFixed(2)}`);
      if (dailyTopUpTokens > 0) topUps.push(`+${formatK(dailyTopUpTokens)} tokens`);
      console.log(`   • Daily Top-Up Active:    ${topUps.join(", ")}`);
    }
  }

  const active = getActiveSession();
  if (active) {
    const isDis = state.disabledSessions[active.id] === true;
    const costCap = state.sessionCostLimits[active.id]?.limit;
    const tokenCap = state.sessionTokenLimits[active.id]?.limit;
    const sessionMetrics = getSessionMetrics(active.id);
    const displayName = sessionMetrics.title || active.title ? `"${sessionMetrics.title || active.title}" (${active.id.slice(0, 8)}...)` : active.id;
    console.log(`\n🎯 \x1b[1mActive Session [${displayName}]:\x1b[0m`);
    console.log(`   • Session Cost Spent:     \x1b[32m$${sessionMetrics.cost.toFixed(2)}\x1b[0m`);
    console.log(`   • Session Tokens Used:    \x1b[33m${sessionMetrics.totalTokens.toLocaleString()}\x1b[0m (In: ${sessionMetrics.tokensInput.toLocaleString()} | Out: ${sessionMetrics.tokensOutput.toLocaleString()})`);
    if (state.globalDisabled === true) {
      console.log(`   • Status:                 \x1b[33mBypassed (Global Disable is active)\x1b[0m`);
    } else if (isDis) {
      console.log(`   • Status:                 \x1b[33mBudget checks disabled for this session\x1b[0m`);
    } else {
      if (costCap !== undefined) {
        const remCost = Math.max(0, costCap - sessionMetrics.cost);
        const costPct = costCap > 0 ? ((sessionMetrics.cost / costCap) * 100).toFixed(1) : "0.0";
        console.log(`   • Session Cost Cap:       \x1b[32m$${costCap.toFixed(2)}\x1b[0m (Spent: $${sessionMetrics.cost.toFixed(2)} | Remaining: \x1b[36m$${remCost.toFixed(2)}\x1b[0m | ${costPct}% used)`);
      } else {
        console.log(`   • Session Cost Cap:       None (unlimited)`);
      }

      if (tokenCap !== undefined) {
        const remTok = Math.max(0, tokenCap - sessionMetrics.totalTokens);
        const tokPct = tokenCap > 0 ? ((sessionMetrics.totalTokens / tokenCap) * 100).toFixed(1) : "0.0";
        console.log(`   • Session Token Cap:      \x1b[33m${formatK(tokenCap)}\x1b[0m (Used: ${formatK(sessionMetrics.totalTokens)} | Remaining: \x1b[36m${formatK(remTok)}\x1b[0m | ${tokPct}% used)`);
      } else {
        console.log(`   • Session Token Cap:      None (unlimited)`);
      }
    }
  }

  console.log(`\n💡 \x1b[1mSlash Commands (Chat Mode):\x1b[0m`);
  console.log(`   • \x1b[36m/budget 15\x1b[0m           Set $15 limit for current session`);
  console.log(`   • \x1b[36m/budget 500k\x1b[0m         Set 500k token limit for current session`);
  console.log(`   • \x1b[36m/budget daily 25\x1b[0m     Set today's daily limit to $25 (or /budget daily +10 for top-up)`);
  console.log(`   • \x1b[36m/budget off\x1b[0m          Disable budget checks for current session`);
  console.log(`   • \x1b[36m/budget off global\x1b[0m   Disable budget checks globally for all sessions`);
  console.log(`   • \x1b[36m/budget on global\x1b[0m    Re-enable budget checks globally`);
  console.log(`   • \x1b[36m/budget history\x1b[0m      View top-up audit history`);
  console.log(`\n🖥️  \x1b[2mRun \x1b[0m\x1b[33mbun run ~/.config/opencode/plugins/cli.ts\x1b[0m\x1b[2m in terminal for full interactive menu.\x1b[0m\n`);
}

async function performUpdate() {
  console.log(`\n🔄 Updating opencode-budget-allowance plugin...`);
  try {
    const globalPluginPath = path.join(os.homedir(), ".config/opencode/plugins/budget.ts");
    const globalCliPath = path.join(os.homedir(), ".config/opencode/plugins/cli.ts");
    const globalCmdDir = path.join(os.homedir(), ".config/opencode/command");
    const globalCmdsDir = path.join(os.homedir(), ".config/opencode/commands");

    fs.mkdirSync(path.dirname(globalPluginPath), { recursive: true });
    fs.mkdirSync(globalCmdDir, { recursive: true });
    fs.mkdirSync(globalCmdsDir, { recursive: true });

    // Clean up deprecated command files
    fs.rmSync(path.join(globalCmdDir, "allocate-budget.md"), { force: true });
    fs.rmSync(path.join(globalCmdsDir, "allocate-budget.md"), { force: true });
    fs.rmSync(path.join(globalCmdsDir, "budget-allowance.md"), { force: true });
    fs.rmSync(path.join(globalCmdDir, "budget-allowance.md"), { force: true });

    const currentFileDir = path.dirname(import.meta.url.replace("file://", ""));
    const repoDir = path.resolve(currentFileDir, "..");
    const isGitRepo = fs.existsSync(path.join(repoDir, ".git")) && fs.existsSync(path.join(repoDir, "src/budget.ts"));

    if (isGitRepo) {
      console.log(`📦 Updating from git repository at ${repoDir}...`);
      try {
        execSync("git pull origin main", { cwd: repoDir, stdio: "inherit" });
      } catch (e: any) {
        console.log(`⚠️ Git pull failed, syncing local files as-is: ${e.message}`);
      }
      fs.copyFileSync(path.join(repoDir, "src/budget.ts"), globalPluginPath);
      fs.copyFileSync(path.join(repoDir, "src/cli.ts"), globalCliPath);
      if (fs.existsSync(path.join(repoDir, "command/budget.md"))) {
        fs.copyFileSync(path.join(repoDir, "command/budget.md"), path.join(globalCmdDir, "budget.md"));
        fs.copyFileSync(path.join(repoDir, "command/budget.md"), path.join(globalCmdsDir, "budget.md"));
      }
    } else {
      console.log(`⬇️ Downloading latest version from GitHub...`);
      const baseUrl = "https://raw.githubusercontent.com/hithismani/opencode-budget-allowance/main";

      const budgetRes = await fetch(`${baseUrl}/src/budget.ts`);
      if (!budgetRes.ok) throw new Error(`Failed to fetch budget.ts: ${budgetRes.statusText}`);
      fs.writeFileSync(globalPluginPath, await budgetRes.text());

      const cliRes = await fetch(`${baseUrl}/src/cli.ts`);
      if (!cliRes.ok) throw new Error(`Failed to fetch cli.ts: ${cliRes.statusText}`);
      fs.writeFileSync(globalCliPath, await cliRes.text());

      const cmdRes = await fetch(`${baseUrl}/command/budget.md`);
      if (cmdRes.ok) {
        const cmdText = await cmdRes.text();
        fs.writeFileSync(path.join(globalCmdDir, "budget.md"), cmdText);
        fs.writeFileSync(path.join(globalCmdsDir, "budget.md"), cmdText);
      }
    }

    console.log(`\x1b[32m✅ Plugin and /budget command updated successfully to ~/.config/opencode/!\x1b[0m\n`);
  } catch (err: any) {
    console.error(`❌ Update failed: ${err.message}\n`);
  }
}

// ============================================================================
// CLI WRAPPER AROUND TS BUDGET ENGINE
// ============================================================================

async function main() {
  const state = loadState();
  const metrics = getOverviewMetrics();
  const todayStr = new Date().toISOString().split("T")[0];

  const args = process.argv.slice(2).join(" ").trim().toLowerCase();

  // If called without arguments in a non-interactive environment (e.g. LLM tool execution),
  // output the status overview immediately rather than hanging on TTY input.
  if (args.length === 0 && !process.stdin.isTTY) {
    printStatusOverview(state, metrics, todayStr);
    return;
  }

  // Direct argument mode
  if (args.length > 0) {
    if (args === "status" || args === "overview" || args === "show" || args === "info" || args === "summary") {
      printStatusOverview(state, metrics, todayStr);
    } else if (
      args === "off global" ||
      args === "global off" ||
      args === "off --global" ||
      args === "disable global" ||
      args === "disable --global"
    ) {
      state.globalDisabled = true;
      state.history.push({
        id: `cli_${Date.now()}`,
        timestamp: Date.now(),
        dateStr: todayStr,
        sessionId: "GLOBAL_ALL",
        model: "CLI_MANUAL",
        scope: "global",
        type: "disable",
        amount: 0,
      });
      saveState(state);
      console.log(`✅ All budget checks and limits are now GLOBALLY DISABLED for all sessions.`);
    } else if (
      args === "on global" ||
      args === "global on" ||
      args === "on --global" ||
      args === "enable global" ||
      args === "enable --global"
    ) {
      state.globalDisabled = false;
      state.history.push({
        id: `cli_${Date.now()}`,
        timestamp: Date.now(),
        dateStr: todayStr,
        sessionId: "GLOBAL_ALL",
        model: "CLI_MANUAL",
        scope: "global",
        type: "enable",
        amount: 0,
      });
      saveState(state);
      console.log(`✅ Global budget checks RE-ENABLED. Session and daily limits are now active.`);
    } else if (args === "off" || args === "disable" || args === "unlimited") {
      const active = getActiveSession();
      if (active) {
        state.disabledSessions[active.id] = true;
        state.history.push({
          id: `cli_${Date.now()}`,
          timestamp: Date.now(),
          dateStr: todayStr,
          sessionId: active.id,
          model: "CLI_MANUAL",
          scope: "session",
          type: "disable",
          amount: 0,
        });
        saveState(state);
        const name = active.title ? `"${active.title}" (${active.id})` : active.id;
        console.log(`✅ Disabled budget checks for session ${name}`);
      } else {
        console.log(`⚠️ No active session found — cannot disable a specific session.`);
      }
    } else if (args === "on" || args === "enable") {
      const active = getActiveSession();
      if (active) {
        delete state.disabledSessions[active.id];
        state.history.push({
          id: `cli_${Date.now()}`,
          timestamp: Date.now(),
          dateStr: todayStr,
          sessionId: active.id,
          model: "CLI_MANUAL",
          scope: "session",
          type: "enable",
          amount: 0,
        });
        saveState(state);
        const name = active.title ? `"${active.title}" (${active.id})` : active.id;
        console.log(`✅ Re-enabled budget checks for session ${name}`);
      } else {
        console.log(`⚠️ No active session found — cannot enable a specific session.`);
      }
    } else if (args === "history" || args === "audit" || args === "log") {
      console.log(`\x1b[1mTop-Up Audit History Log:\x1b[0m`);
      if (state.history.length === 0) {
        console.log(`  (No top-up records found)`);
      } else {
        state.history.slice(-10).reverse().forEach((rec) => {
          const date = new Date(rec.timestamp).toLocaleString();
          const amtStr =
            rec.type === "cost"
              ? `$${rec.amount.toFixed(2)}`
              : rec.type === "token"
              ? formatK(rec.amount)
              : rec.type;
          console.log(`  • [${date}] Scope: ${rec.scope} | Type: ${rec.type} | Amount: ${amtStr} | Session: ${rec.sessionId}`);
        });
      }
    } else if (args.startsWith("daily ")) {
      const rawArg = args.slice(6).trim();
      const isTopUp = rawArg.startsWith("+") || rawArg.startsWith("topup ") || rawArg.startsWith("add ");
      const amountStr = rawArg.replace(/^\+/, "").replace(/^topup\s+/, "").replace(/^add\s+/, "").trim();
      const parsed = parseAmount(amountStr);
      if (parsed) {
        if (parsed.type === "cost") {
          const prevTopUp = state.dailyTopUpUSD[todayStr] || 0;
          const newTopUp = isTopUp ? prevTopUp + parsed.value : parsed.value;
          state.dailyTopUpUSD[todayStr] = newTopUp;
          state.history.push({
            id: `cli_${Date.now()}`,
            timestamp: Date.now(),
            dateStr: todayStr,
            sessionId: "GLOBAL_DAILY",
            model: "CLI_MANUAL",
            scope: "daily",
            type: "cost",
            amount: parsed.value,
          });
          saveState(state);
          const remaining = Math.max(0, newTopUp - metrics.dailyCost);
          const pct = newTopUp > 0 ? ((metrics.dailyCost / newTopUp) * 100).toFixed(1) : "0.0";
          console.log(`✅ ${isTopUp ? "Topped up" : "Set"} daily cost budget cap to $${newTopUp.toFixed(2)} for today (${todayStr})!`);
          console.log(`   • Spent today so far: $${metrics.dailyCost.toFixed(2)} across ${metrics.sessionCount} sessions`);
          console.log(`   • Remaining / Pending daily allowance: \x1b[36m$${remaining.toFixed(2)}\x1b[0m (${pct}% used)`);
        } else {
          const prevTopUp = state.dailyTopUpTokens[todayStr] || 0;
          const newTopUp = isTopUp ? prevTopUp + parsed.value : parsed.value;
          state.dailyTopUpTokens[todayStr] = newTopUp;
          state.history.push({
            id: `cli_${Date.now()}`,
            timestamp: Date.now(),
            dateStr: todayStr,
            sessionId: "GLOBAL_DAILY",
            model: "CLI_MANUAL",
            scope: "daily",
            type: "token",
            amount: parsed.value,
          });
          saveState(state);
          const remaining = Math.max(0, newTopUp - metrics.dailyTokens);
          const pct = newTopUp > 0 ? ((metrics.dailyTokens / newTopUp) * 100).toFixed(1) : "0.0";
          console.log(`✅ ${isTopUp ? "Topped up" : "Set"} daily token budget cap to ${formatK(newTopUp)} tokens for today (${todayStr})!`);
          console.log(`   • Tokens used today: ${metrics.dailyTokens.toLocaleString()}`);
          console.log(`   • Remaining / Pending daily tokens: \x1b[36m${formatK(remaining)}\x1b[0m (${pct}% used)`);
        }
      } else {
        console.log(`❌ Invalid amount for daily allowance: "${amountStr}"`);
      }
    } else if (args === "help" || args === "-h" || args === "--help") {
      printStatusOverview(state, metrics, todayStr);
    } else {
      const parsed = parseAmount(args);
      if (parsed) {
        const active = getActiveSession();
        if (active) {
          delete state.disabledSessions[active.id];
          const sessionMetrics = getSessionMetrics(active.id);
          const name = sessionMetrics.title || active.title ? `"${sessionMetrics.title || active.title}"` : active.id;
          if (parsed.type === "cost") {
            state.sessionCostLimits[active.id] = { limit: parsed.value, model: "CLI_MANUAL" };
            state.history.push({
              id: `cli_${Date.now()}`,
              timestamp: Date.now(),
              dateStr: todayStr,
              sessionId: active.id,
              model: "CLI_MANUAL",
              scope: "session",
              type: "cost",
              amount: parsed.value,
            });
            saveState(state);
            const remaining = Math.max(0, parsed.value - sessionMetrics.cost);
            const pct = parsed.value > 0 ? ((sessionMetrics.cost / parsed.value) * 100).toFixed(1) : "0.0";
            console.log(`✅ Locked session allowance cap at $${parsed.value.toFixed(2)} for session ${name}`);
            console.log(`   • Spent so far in this session: $${sessionMetrics.cost.toFixed(2)}`);
            console.log(`   • Remaining / Pending session allowance: \x1b[36m$${remaining.toFixed(2)}\x1b[0m (${pct}% used)`);
          } else {
            state.sessionTokenLimits[active.id] = { limit: parsed.value, model: "CLI_MANUAL" };
            state.history.push({
              id: `cli_${Date.now()}`,
              timestamp: Date.now(),
              dateStr: todayStr,
              sessionId: active.id,
              model: "CLI_MANUAL",
              scope: "session",
              type: "token",
              amount: parsed.value,
            });
            saveState(state);
            const remaining = Math.max(0, parsed.value - sessionMetrics.totalTokens);
            const pct = parsed.value > 0 ? ((sessionMetrics.totalTokens / parsed.value) * 100).toFixed(1) : "0.0";
            console.log(`✅ Locked session allowance cap at ${formatK(parsed.value)} tokens for session ${name}`);
            console.log(`   • Tokens used in this session: ${sessionMetrics.totalTokens.toLocaleString()}`);
            console.log(`   • Remaining / Pending session tokens: \x1b[36m${formatK(remaining)}\x1b[0m (${pct}% used)`);
          }
        } else {
          console.log(`⚠️ No active session found — cannot set a session cap.`);
        }
      } else {
        console.log(`❌ Unknown argument: "${args}". Use "15", "500k", "daily 25", "off", "off global", "on global", "status", or "history".`);
      }
    }
    return;
  }

  // Interactive menu mode (Terminal TTY)
  if (process.stdout.isTTY) process.stdout.write(DISABLE_MOUSE);

  console.clear();
  console.log(`\x1b[1m\x1b[36m================================================================\x1b[0m`);
  console.log(`💳 \x1b[1mOPENCODE BUDGET ALLOWANCE CLI\x1b[0m \x1b[2m(100% Offline - 0 LLM Tokens Burned)\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m================================================================\x1b[0m\n`);

  console.log(`📊 \x1b[1mToday's Spend Overview (${todayStr}):\x1b[0m`);
  console.log(`   • Total Cost Spent:       \x1b[32m$${metrics.dailyCost.toFixed(2)}\x1b[0m`);
  console.log(`   • Total Tokens Used:      \x1b[33m${metrics.dailyTokens.toLocaleString()}\x1b[0m`);
  console.log(`   • Active Sessions Today:  ${metrics.sessionCount}`);
  console.log(`   • Avg Cost / Session:     $${metrics.avgCost.toFixed(2)}\n`);

  const globalStatus = state.globalDisabled ? "\x1b[31m[GLOBALLY DISABLED]\x1b[0m" : "\x1b[32m[Active]\x1b[0m";
  console.log(`\x1b[1mSelect an option:\x1b[0m`);
  console.log(`  \x1b[36m1)\x1b[0m Set / Top-Up Daily Budget Limit`);
  console.log(`  \x1b[36m2)\x1b[0m Set Budget Cap for a Session`);
  console.log(`  \x1b[36m3)\x1b[0m Disable / Re-enable Budget Checks for a Session`);
  console.log(`  \x1b[36m4)\x1b[0m Toggle Global Budget Checks (All Sessions) ${globalStatus}`);
  console.log(`  \x1b[36m5)\x1b[0m View Top-Up Audit History Log`);
  console.log(`  \x1b[36m6)\x1b[0m Update Plugin & Slash Command (git pull & sync)`);
  console.log(`  \x1b[36m7)\x1b[0m Exit\n`);

  const choice = await ask(`\x1b[1mEnter choice [1-7]: \x1b[0m`);

  if (choice === "1") {
    const { effectiveDailyCostLimit, effectiveDailyTokenLimit } = getEffectiveDailyLimits(state, {}, todayStr);
    console.log(`\n📊 \x1b[1mDaily Budget Info (${todayStr}):\x1b[0m`);
    console.log(`   • Spent Today: $${metrics.dailyCost.toFixed(2)} (${metrics.dailyTokens.toLocaleString()} tokens)`);
    if (effectiveDailyCostLimit !== Infinity) {
      const rem = Math.max(0, effectiveDailyCostLimit - metrics.dailyCost);
      console.log(`   • Current Daily Cost Cap: $${effectiveDailyCostLimit.toFixed(2)} (Remaining: $${rem.toFixed(2)})`);
    } else {
      console.log(`   • Current Daily Cost Cap: None (unlimited)`);
    }
    if (effectiveDailyTokenLimit !== Infinity) {
      const remTok = Math.max(0, effectiveDailyTokenLimit - metrics.dailyTokens);
      console.log(`   • Current Daily Token Cap: ${formatK(effectiveDailyTokenLimit)} (Remaining: ${formatK(remTok)})`);
    }
    console.log(`\nTip: Enter an amount to set the target cap (e.g. 25.00), or prefix with '+' to top-up (e.g. +10.00).`);
    const inputStr = await ask(`Enter daily budget (e.g. 25.00, 500k, +10.00): `);
    const isTopUp = inputStr.startsWith("+") || inputStr.startsWith("topup ") || inputStr.startsWith("add ");
    const amountStr = inputStr.replace(/^\+/, "").replace(/^topup\s+/, "").replace(/^add\s+/, "").trim();
    const parsed = parseAmount(amountStr);
    if (parsed) {
      if (parsed.type === "cost") {
        const prevTopUp = state.dailyTopUpUSD[todayStr] || 0;
        const newTopUp = isTopUp ? prevTopUp + parsed.value : parsed.value;
        state.dailyTopUpUSD[todayStr] = newTopUp;
        state.history.push({
          id: `cli_${Date.now()}`,
          timestamp: Date.now(),
          dateStr: todayStr,
          sessionId: "GLOBAL_DAILY",
          model: "CLI_MANUAL",
          scope: "daily",
          type: "cost",
          amount: parsed.value,
        });
        saveState(state);
        const remaining = Math.max(0, newTopUp - metrics.dailyCost);
        const pct = newTopUp > 0 ? ((metrics.dailyCost / newTopUp) * 100).toFixed(1) : "0.0";
        console.log(`\n\x1b[32m✅ ${isTopUp ? "Topped up" : "Set"} daily cost budget cap to $${newTopUp.toFixed(2)}!\x1b[0m`);
        console.log(`   • Spent today: $${metrics.dailyCost.toFixed(2)}`);
        console.log(`   • Remaining / Pending daily allowance: \x1b[36m$${remaining.toFixed(2)}\x1b[0m (${pct}% used)\n`);
      } else {
        const prevTopUp = state.dailyTopUpTokens[todayStr] || 0;
        const newTopUp = isTopUp ? prevTopUp + parsed.value : parsed.value;
        state.dailyTopUpTokens[todayStr] = newTopUp;
        state.history.push({
          id: `cli_${Date.now()}`,
          timestamp: Date.now(),
          dateStr: todayStr,
          sessionId: "GLOBAL_DAILY",
          model: "CLI_MANUAL",
          scope: "daily",
          type: "token",
          amount: parsed.value,
        });
        saveState(state);
        const remaining = Math.max(0, newTopUp - metrics.dailyTokens);
        const pct = newTopUp > 0 ? ((metrics.dailyTokens / newTopUp) * 100).toFixed(1) : "0.0";
        console.log(`\n\x1b[32m✅ ${isTopUp ? "Topped up" : "Set"} daily token budget cap to ${formatK(newTopUp)} tokens!\x1b[0m`);
        console.log(`   • Tokens used today: ${metrics.dailyTokens.toLocaleString()}`);
        console.log(`   • Remaining / Pending daily tokens: \x1b[36m${formatK(remaining)}\x1b[0m (${pct}% used)\n`);
      }
    } else {
      console.log(`\n❌ Invalid amount.\n`);
    }
  } else if (choice === "2") {
    if (metrics.sessions.length === 0) {
      console.log(`\n⚠️ No recent sessions found in SQLite database.\n`);
    } else {
      console.log(`\n\x1b[1mRecent Sessions:\x1b[0m`);
      metrics.sessions.forEach((s, idx) => {
        const costCap = state.sessionCostLimits[s.id]?.limit;
        const capInfo = costCap !== undefined ? ` | Cap: $${costCap.toFixed(2)} (Rem: $${Math.max(0, costCap - s.cost).toFixed(2)})` : "";
        console.log(`  \x1b[36m${idx + 1})\x1b[0m [${s.id}] ${s.title || "Untitled"} (Spent: $${s.cost.toFixed(2)}${capInfo})`);
      });

      const idxStr = await ask(`\nSelect session number [1-${metrics.sessions.length}]: `);
      const idx = parseInt(idxStr, 10) - 1;

      if (idx >= 0 && idx < metrics.sessions.length) {
        const targetSession = metrics.sessions[idx];
        const sMetrics = getSessionMetrics(targetSession.id);
        const capStr = await ask(`Enter budget limit cap for "${targetSession.title || targetSession.id}" (e.g. 15.00 or 500k): `);
        const parsed = parseAmount(capStr);

        if (parsed) {
          delete state.disabledSessions[targetSession.id];
          if (parsed.type === "cost") {
            state.sessionCostLimits[targetSession.id] = { limit: parsed.value, model: "CLI_MANUAL" };
            state.history.push({
              id: `cli_${Date.now()}`,
              timestamp: Date.now(),
              dateStr: todayStr,
              sessionId: targetSession.id,
              model: "CLI_MANUAL",
              scope: "session",
              type: "cost",
              amount: parsed.value,
            });
            saveState(state);
            const remaining = Math.max(0, parsed.value - sMetrics.cost);
            const pct = parsed.value > 0 ? ((sMetrics.cost / parsed.value) * 100).toFixed(1) : "0.0";
            console.log(`\n\x1b[32m✅ Locked session allowance cap at $${parsed.value.toFixed(2)}!\x1b[0m`);
            console.log(`   • Spent so far: $${sMetrics.cost.toFixed(2)}`);
            console.log(`   • Remaining / Pending session allowance: \x1b[36m$${remaining.toFixed(2)}\x1b[0m (${pct}% used)\n`);
          } else {
            state.sessionTokenLimits[targetSession.id] = { limit: parsed.value, model: "CLI_MANUAL" };
            state.history.push({
              id: `cli_${Date.now()}`,
              timestamp: Date.now(),
              dateStr: todayStr,
              sessionId: targetSession.id,
              model: "CLI_MANUAL",
              scope: "session",
              type: "token",
              amount: parsed.value,
            });
            saveState(state);
            const remaining = Math.max(0, parsed.value - sMetrics.totalTokens);
            const pct = parsed.value > 0 ? ((sMetrics.totalTokens / parsed.value) * 100).toFixed(1) : "0.0";
            console.log(`\n\x1b[32m✅ Locked session allowance cap at ${formatK(parsed.value)} tokens!\x1b[0m`);
            console.log(`   • Tokens used so far: ${sMetrics.totalTokens.toLocaleString()}`);
            console.log(`   • Remaining / Pending session tokens: \x1b[36m${formatK(remaining)}\x1b[0m (${pct}% used)\n`);
          }
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

      const idxStr = await ask(`\nSelect session number to toggle [1-${metrics.sessions.length}]: `);
      const idx = parseInt(idxStr, 10) - 1;

      if (idx >= 0 && idx < metrics.sessions.length) {
        const targetSession = metrics.sessions[idx];
        if (state.disabledSessions[targetSession.id]) {
          delete state.disabledSessions[targetSession.id];
          state.history.push({
            id: `cli_${Date.now()}`,
            timestamp: Date.now(),
            dateStr: todayStr,
            sessionId: targetSession.id,
            model: "CLI_MANUAL",
            scope: "session",
            type: "enable",
            amount: 0,
          });
          saveState(state);
          console.log(`\n\x1b[32m✅ Re-enabled budget checks for session ${targetSession.id}!\x1b[0m\n`);
        } else {
          state.disabledSessions[targetSession.id] = true;
          state.history.push({
            id: `cli_${Date.now()}`,
            timestamp: Date.now(),
            dateStr: todayStr,
            sessionId: targetSession.id,
            model: "CLI_MANUAL",
            scope: "session",
            type: "disable",
            amount: 0,
          });
          saveState(state);
          console.log(`\n\x1b[32m✅ Disabled budget checks for session ${targetSession.id}!\x1b[0m\n`);
        }
      }
    }
  } else if (choice === "4") {
    if (state.globalDisabled) {
      const confirm = await ask(`Global budget checks are currently DISABLED. Re-enable globally? (y/n): `);
      if (confirm.toLowerCase().startsWith("y")) {
        state.globalDisabled = false;
        state.history.push({
          id: `cli_${Date.now()}`,
          timestamp: Date.now(),
          dateStr: todayStr,
          sessionId: "GLOBAL_ALL",
          model: "CLI_MANUAL",
          scope: "global",
          type: "enable",
          amount: 0,
        });
        saveState(state);
        console.log(`\n\x1b[32m✅ Global budget checks RE-ENABLED.\x1b[0m\n`);
      }
    } else {
      const confirm = await ask(`Disable ALL budget limits and checks globally for all sessions? (y/n): `);
      if (confirm.toLowerCase().startsWith("y")) {
        state.globalDisabled = true;
        state.history.push({
          id: `cli_${Date.now()}`,
          timestamp: Date.now(),
          dateStr: todayStr,
          sessionId: "GLOBAL_ALL",
          model: "CLI_MANUAL",
          scope: "global",
          type: "disable",
          amount: 0,
        });
        saveState(state);
        console.log(`\n\x1b[33m✅ All budget checks GLOBALLY DISABLED.\x1b[0m\n`);
      }
    }
  } else if (choice === "5") {
    console.log(`\n\x1b[1mTop-Up Audit History Log:\x1b[0m`);
    if (state.history.length === 0) {
      console.log(`  (No top-up records found)`);
    } else {
      state.history.slice(-10).reverse().forEach((rec) => {
        const date = new Date(rec.timestamp).toLocaleString();
        const amtStr =
          rec.type === "cost"
            ? `$${rec.amount.toFixed(2)}`
            : rec.type === "token"
            ? formatK(rec.amount)
            : rec.type;
        console.log(`  • [${date}] Scope: ${rec.scope} | Type: ${rec.type} | Amount: ${amtStr} | Session: ${rec.sessionId}`);
      });
    }
    console.log("");
  } else if (choice === "6") {
    console.log(`\n🔄 Updating opencode-budget-allowance plugin...`);
    try {
      const repoDir = path.resolve(path.dirname(import.meta.url.replace("file://", "")), "..");
      if (fs.existsSync(path.join(repoDir, ".git"))) {
        execSync("git pull origin main", { cwd: repoDir, stdio: "inherit" });
      }

      const globalPluginPath = path.join(os.homedir(), ".config/opencode/plugins/budget.ts");
      const globalCliPath = path.join(os.homedir(), ".config/opencode/plugins/cli.ts");
      const globalCmdDir = path.join(os.homedir(), ".config/opencode/command");
      const globalCmdsDir = path.join(os.homedir(), ".config/opencode/commands");

      fs.mkdirSync(path.dirname(globalPluginPath), { recursive: true });
      fs.mkdirSync(globalCmdDir, { recursive: true });
      fs.mkdirSync(globalCmdsDir, { recursive: true });

      fs.copyFileSync(path.join(repoDir, "src/budget.ts"), globalPluginPath);
      fs.copyFileSync(path.join(repoDir, "src/cli.ts"), globalCliPath);

      // Clean up deprecated command files
      fs.rmSync(path.join(globalCmdDir, "allocate-budget.md"), { force: true });
      fs.rmSync(path.join(globalCmdsDir, "allocate-budget.md"), { force: true });
      fs.rmSync(path.join(globalCmdDir, "budget-allowance.md"), { force: true });
      fs.rmSync(path.join(globalCmdsDir, "budget-allowance.md"), { force: true });

      if (fs.existsSync(path.join(repoDir, "command/budget.md"))) {
        fs.copyFileSync(path.join(repoDir, "command/budget.md"), path.join(globalCmdDir, "budget.md"));
        fs.copyFileSync(path.join(repoDir, "command/budget.md"), path.join(globalCmdsDir, "budget.md"));
      }

      console.log(`\x1b[32m✅ Plugin and /budget command updated successfully to ~/.config/opencode/!\x1b[0m\n`);
    } catch (err: any) {
      console.error(`❌ Update failed: ${err.message}\n`);
    }
  }

  if (process.stdout.isTTY) process.stdout.write(ENABLE_MOUSE);
}

// Only run the interactive menu when this file is executed directly
// (e.g. `bun run cli.ts`). opencode imports every .ts file under
// plugins/, and without this guard the menu would render on launch.
if (import.meta.main) {
  main().catch(console.error);
}
