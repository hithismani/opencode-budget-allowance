#!/usr/bin/env node

import { execSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import { loadState, saveState, getOverviewMetrics } from "./budget.ts";

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
// CLI WRAPPER AROUND TS BUDGET ENGINE
// ============================================================================

async function main() {
  if (process.stdout.isTTY) process.stdout.write(DISABLE_MOUSE);

  const state = loadState();
  const metrics = getOverviewMetrics();
  const todayStr = new Date().toISOString().split("T")[0];

  // Direct argument mode: /budget-allowance 15, /budget-allowance daily 25,
  // /budget-allowance off, /budget-allowance history, ...
  const args = process.argv.slice(2).join(" ").trim().toLowerCase();
  if (args.length > 0) {
    if (args === "off" || args === "disable" || args === "unlimited") {
      if (process.env.OPENCODE_SESSION_ID) {
        state.disabledSessions[process.env.OPENCODE_SESSION_ID] = true;
        saveState(state);
        console.log(`✅ Disabled budget checks for session ${process.env.OPENCODE_SESSION_ID}`);
      } else {
        console.log(`⚠️ No OPENCODE_SESSION_ID set — cannot disable a specific session.`);
      }
    } else if (args === "history" || args === "audit") {
      console.log(`Top-Up Audit History Log:`);
      if (state.history.length === 0) {
        console.log(`  (No top-up records found)`);
      } else {
        state.history.slice(-10).reverse().forEach((rec) => {
          const date = new Date(rec.timestamp).toLocaleString();
          console.log(`  • [${date}] Scope: ${rec.scope} | Type: ${rec.type} | Amount: $${rec.amount.toFixed(2)} | Session: ${rec.sessionId}`);
        });
      }
    } else if (args.startsWith("daily ")) {
      const amount = parseFloat(args.slice(6));
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
        console.log(`✅ Added +$${amount.toFixed(2)} to daily budget allowance!`);
      } else {
        console.log(`❌ Invalid amount for "daily".`);
      }
    } else {
      const amount = parseFloat(args);
      if (!isNaN(amount) && amount > 0) {
        if (process.env.OPENCODE_SESSION_ID) {
          state.sessionCostLimits[process.env.OPENCODE_SESSION_ID] = { limit: amount, model: "CLI_MANUAL" };
          delete state.disabledSessions[process.env.OPENCODE_SESSION_ID];
          saveState(state);
          console.log(`✅ Locked session allowance cap at $${amount.toFixed(2)} for session ${process.env.OPENCODE_SESSION_ID}`);
        } else {
          console.log(`⚠️ No OPENCODE_SESSION_ID set — cannot set a session cap.`);
        }
      } else {
        console.log(`❌ Unknown argument: "${args}"`);
      }
    }
    if (process.stdout.isTTY) process.stdout.write(ENABLE_MOUSE);
    return;
  }

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

  const choice = await ask(`\x1b[1mEnter choice [1-6]: \x1b[0m`);

  if (choice === "1") {
    const amountStr = await ask(`Enter extra daily dollar top-up (e.g. 10.00): $`);
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

      const idxStr = await ask(`\nSelect session number [1-${metrics.sessions.length}]: `);
      const idx = parseInt(idxStr, 10) - 1;

      if (idx >= 0 && idx < metrics.sessions.length) {
        const targetSession = metrics.sessions[idx];
        const capStr = await ask(`Enter budget limit cap for "${targetSession.title || targetSession.id}": $`);
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

      const idxStr = await ask(`\nSelect session number to disable budget [1-${metrics.sessions.length}]: `);
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

  if (process.stdout.isTTY) process.stdout.write(ENABLE_MOUSE);
}

// Only run the interactive menu when this file is executed directly
// (e.g. `bun run cli.ts`). opencode imports every .ts file under
// plugins/, and without this guard the menu would render on launch.
if (import.meta.main) {
  main().catch(console.error);
}
