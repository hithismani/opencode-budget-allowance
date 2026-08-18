#!/usr/bin/env node

import { execSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import { loadState, saveState, getOverviewMetrics, formatK, type BudgetState } from "./budget.ts";

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
  console.log(`\x1b[1m\x1b[36m================================================================\x1b[0m`);
  console.log(`💳 \x1b[1mOPENCODE BUDGET ALLOWANCE\x1b[0m \x1b[2m(100% Offline - 0 LLM Tokens)\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m================================================================\x1b[0m\n`);

  console.log(`📊 \x1b[1mToday's Spend Overview (${todayStr}):\x1b[0m`);
  console.log(`   • Total Cost Spent:       \x1b[32m$${metrics.dailyCost.toFixed(2)}\x1b[0m`);
  console.log(`   • Total Tokens Used:      \x1b[33m${metrics.dailyTokens.toLocaleString()}\x1b[0m`);
  console.log(`   • Active Sessions Today:  ${metrics.sessionCount}`);
  console.log(`   • Avg Cost / Session:     $${metrics.avgCost.toFixed(2)}\n`);

  console.log(`⚙️  \x1b[1mGlobal Budget Status:\x1b[0m`);
  if (state.globalDisabled === true) {
    console.log(`   • Status:                 \x1b[31mGLOBALLY DISABLED (all checks bypassed)\x1b[0m`);
  } else {
    console.log(`   • Status:                 \x1b[32mActive (limits enforced)\x1b[0m`);
    const dailyTopUpUSD = state.dailyTopUpUSD[todayStr] || 0;
    const dailyTopUpTokens = state.dailyTopUpTokens[todayStr] || 0;
    console.log(`   • Daily Cost Top-Up:      ${dailyTopUpUSD > 0 ? `+$${dailyTopUpUSD.toFixed(2)}` : "None"}`);
    if (dailyTopUpTokens > 0) {
      console.log(`   • Daily Token Top-Up:     +${formatK(dailyTopUpTokens)}`);
    }
  }

  const active = getActiveSession();
  if (active) {
    const isDis = state.disabledSessions[active.id] === true;
    const costCap = state.sessionCostLimits[active.id]?.limit;
    const tokenCap = state.sessionTokenLimits[active.id]?.limit;
    const displayName = active.title ? `"${active.title}" (${active.id.slice(0, 8)}...)` : active.id;
    console.log(`\n🎯 \x1b[1mActive Session [${displayName}]:\x1b[0m`);
    if (state.globalDisabled === true) {
      console.log(`   • Status:                 \x1b[33mBypassed (Global Disable is active)\x1b[0m`);
    } else if (isDis) {
      console.log(`   • Status:                 \x1b[33mBudget checks disabled for this session\x1b[0m`);
    } else if (costCap !== undefined) {
      console.log(`   • Session Cost Cap:       \x1b[32m$${costCap.toFixed(2)}\x1b[0m`);
    } else if (tokenCap !== undefined) {
      console.log(`   • Session Token Cap:      \x1b[32m${formatK(tokenCap)}\x1b[0m`);
    } else {
      console.log(`   • Session Limit:          None (unlimited)`);
    }
  }

  console.log(`\n💡 \x1b[1mSlash Commands (Chat Mode):\x1b[0m`);
  console.log(`   • \x1b[36m/budget 15\x1b[0m           Set $15 limit for current session`);
  console.log(`   • \x1b[36m/budget 500k\x1b[0m         Set 500k token limit for current session`);
  console.log(`   • \x1b[36m/budget daily 25\x1b[0m     Add $25 to daily allowance`);
  console.log(`   • \x1b[36m/budget off\x1b[0m          Disable budget checks for current session`);
  console.log(`   • \x1b[36m/budget off global\x1b[0m   Disable budget checks globally for all sessions`);
  console.log(`   • \x1b[36m/budget on global\x1b[0m    Re-enable budget checks globally`);
  console.log(`   • \x1b[36m/budget history\x1b[0m      View top-up audit history`);
  console.log(`\n🖥️  \x1b[2mRun \x1b[0m\x1b[33mbun run ~/.config/opencode/plugins/cli.ts\x1b[0m\x1b[2m in terminal for full interactive menu.\x1b[0m\n`);
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
      const amountStr = args.slice(6).trim();
      const parsed = parseAmount(amountStr);
      if (parsed) {
        if (parsed.type === "cost") {
          state.dailyTopUpUSD[todayStr] = (state.dailyTopUpUSD[todayStr] || 0) + parsed.value;
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
          console.log(`✅ Added +$${parsed.value.toFixed(2)} to daily budget allowance!`);
        } else {
          state.dailyTopUpTokens[todayStr] = (state.dailyTopUpTokens[todayStr] || 0) + parsed.value;
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
          console.log(`✅ Added +${formatK(parsed.value)} tokens to daily budget allowance!`);
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
            const name = active.title ? `"${active.title}"` : active.id;
            console.log(`✅ Locked session allowance cap at $${parsed.value.toFixed(2)} for session ${name}`);
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
            const name = active.title ? `"${active.title}"` : active.id;
            console.log(`✅ Locked session allowance cap at ${formatK(parsed.value)} tokens for session ${name}`);
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
  console.log(`  \x1b[36m1)\x1b[0m Set Daily Budget Limit`);
  console.log(`  \x1b[36m2)\x1b[0m Set Budget Cap for a Session`);
  console.log(`  \x1b[36m3)\x1b[0m Disable / Re-enable Budget Checks for a Session`);
  console.log(`  \x1b[36m4)\x1b[0m Toggle Global Budget Checks (All Sessions) ${globalStatus}`);
  console.log(`  \x1b[36m5)\x1b[0m View Top-Up Audit History Log`);
  console.log(`  \x1b[36m6)\x1b[0m Update Plugin & Slash Command (git pull & sync)`);
  console.log(`  \x1b[36m7)\x1b[0m Exit\n`);

  const choice = await ask(`\x1b[1mEnter choice [1-7]: \x1b[0m`);

  if (choice === "1") {
    const amountStr = await ask(`Enter daily top-up (e.g. 10.00 or 500k): `);
    const parsed = parseAmount(amountStr);
    if (parsed) {
      if (parsed.type === "cost") {
        state.dailyTopUpUSD[todayStr] = (state.dailyTopUpUSD[todayStr] || 0) + parsed.value;
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
        console.log(`\n\x1b[32m✅ Added +$${parsed.value.toFixed(2)} to daily budget allowance!\x1b[0m\n`);
      } else {
        state.dailyTopUpTokens[todayStr] = (state.dailyTopUpTokens[todayStr] || 0) + parsed.value;
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
        console.log(`\n\x1b[32m✅ Added +${formatK(parsed.value)} tokens to daily budget allowance!\x1b[0m\n`);
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
        console.log(`  \x1b[36m${idx + 1})\x1b[0m [${s.id}] ${s.title || "Untitled"} ($${s.cost.toFixed(2)})`);
      });

      const idxStr = await ask(`\nSelect session number [1-${metrics.sessions.length}]: `);
      const idx = parseInt(idxStr, 10) - 1;

      if (idx >= 0 && idx < metrics.sessions.length) {
        const targetSession = metrics.sessions[idx];
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
            console.log(`\n\x1b[32m✅ Locked session allowance cap at $${parsed.value.toFixed(2)}!\x1b[0m\n`);
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
            console.log(`\n\x1b[32m✅ Locked session allowance cap at ${formatK(parsed.value)} tokens!\x1b[0m\n`);
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
