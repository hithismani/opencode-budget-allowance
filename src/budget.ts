import type { Plugin } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import os from "os";

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

export interface BudgetOptions {
  defaultDailyLimitUSD?: number;       // Defaults to Infinity (Unlimited unless set)
  defaultSessionLimitUSD?: number;     // Defaults to Infinity (Unlimited unless set)
  defaultDailyTokenLimit?: number;     // Defaults to Infinity (Unlimited unless set)
  defaultSessionTokenLimit?: number;   // Defaults to Infinity (Unlimited unless set)
  compactAtInputTokens?: number;       // Auto-compaction input token threshold (default: 120,000)
  modelCostBudgets?: Record<string, number>;  // Per-model default cost limits { "fable-5": 10.0 }
  modelTokenBudgets?: Record<string, number>; // Per-model default token limits { "fable-5": 200000 }
}

export interface TopUpRecord {
  id: string;
  timestamp: number;
  dateStr: string;
  sessionId: string;
  model: string;
  scope: "daily" | "session";
  type: "cost" | "token" | "disable";
  amount: number;
}

export interface BudgetState {
  dailyTopUpUSD: Record<string, number>;
  dailyTopUpTokens: Record<string, number>;
  sessionCostLimits: Record<string, { limit: number; model: string }>;
  sessionTokenLimits: Record<string, { limit: number; model: string }>;
  disabledSessions: Record<string, boolean>;
  history: TopUpRecord[];
}

// ============================================================================
// PATHS & CONSTANTS
// ============================================================================

export const dbPath = path.join(os.homedir(), ".local/share/opencode/opencode.db");
export const statePath = path.join(os.homedir(), ".config/opencode/budget-overrides.json");

// Compact number formatter (610k, 1.2M)
export function formatK(num: number): string {
  if (num === Infinity || num < 0 || isNaN(num)) return "∞";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(0)}k`;
  return `${num}`;
}

// ============================================================================
// PERSISTENCE HELPERS
// ============================================================================

export function loadState(): BudgetState {
  try {
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      return {
        dailyTopUpUSD: parsed.dailyTopUpUSD || {},
        dailyTopUpTokens: parsed.dailyTopUpTokens || {},
        sessionCostLimits: parsed.sessionCostLimits || {},
        sessionTokenLimits: parsed.sessionTokenLimits || {},
        disabledSessions: parsed.disabledSessions || {},
        history: parsed.history || [],
      };
    }
  } catch (err) {
    // Silent fail
  }
  return {
    dailyTopUpUSD: {},
    dailyTopUpTokens: {},
    sessionCostLimits: {},
    sessionTokenLimits: {},
    disabledSessions: {},
    history: [],
  };
}

export function saveState(state: BudgetState): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("❌ Failed to save budget state:", err);
  }
}

// ============================================================================
// SQLITE QUERY HELPERS
// ============================================================================

export function queryDb<T>(queryFn: (db: Database) => T, fallback: T): T {
  if (!fs.existsSync(dbPath)) return fallback;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return queryFn(db);
  } catch (err) {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

export function getOverviewMetrics() {
  return queryDb(
    (db) => {
      const startOfDayMs = new Date().setHours(0, 0, 0, 0);

      const dailyRow = db.query(`
        SELECT 
          COALESCE(SUM(cost), 0) AS dailyCost,
          COALESCE(SUM(tokens_input + tokens_output), 0) AS dailyTokens,
          COUNT(id) AS sessionCount,
          COALESCE(AVG(cost), 0) AS avgCost
        FROM session WHERE time_created >= ?
      `).get(startOfDayMs) as {
        dailyCost: number;
        dailyTokens: number;
        sessionCount: number;
        avgCost: number;
      };

      const recentSessions = db.query(`
        SELECT id, title, cost, tokens_input + tokens_output AS totalTokens, time_updated 
        FROM session ORDER BY time_updated DESC LIMIT 10
      `).all() as Array<{ id: string; title: string; cost: number; totalTokens: number; time_updated: number }>;

      return {
        dailyCost: dailyRow?.dailyCost ?? 0,
        dailyTokens: dailyRow?.dailyTokens ?? 0,
        sessionCount: dailyRow?.sessionCount ?? 0,
        avgCost: dailyRow?.avgCost ?? 0,
        sessions: recentSessions,
      };
    },
    { dailyCost: 0, dailyTokens: 0, sessionCount: 0, avgCost: 0, sessions: [] }
  );
}

// ============================================================================
// PLUGIN MAIN EXPORT
// ============================================================================

export default (async ({ client }, options: BudgetOptions = {}) => {
  const {
    defaultDailyLimitUSD = Infinity,    // NO DEFAULT CAP unless explicitly set
    defaultSessionLimitUSD = Infinity,  // NO DEFAULT CAP unless explicitly set
    defaultDailyTokenLimit = Infinity,  // NO DEFAULT CAP unless explicitly set
    defaultSessionTokenLimit = Infinity,// NO DEFAULT CAP unless explicitly set
    compactAtInputTokens = 120_000,
    modelCostBudgets = {},
    modelTokenBudgets = {},
  } = options;

  return {
    // Clean System Context Awareness (Zero TUI Console Clutter + 90% Toast Warning)
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID || "";
      const modelName = input.model?.id || "Active Model";
      const todayStr = new Date().toISOString().split("T")[0];
      const state = loadState();
      const isSessionDisabled = state.disabledSessions[sessionId] === true;

      if (isSessionDisabled) {
        output.system.push(`[Opencode Budget Allowance Plugin: Disabled for session ${sessionId}]`);
        return;
      }

      const matchedCostKey = Object.keys(modelCostBudgets).find((k) =>
        modelName.toLowerCase().includes(k.toLowerCase())
      );
      const sessionCostLimit =
        state.sessionCostLimits[sessionId]?.limit ??
        (matchedCostKey ? modelCostBudgets[matchedCostKey] : defaultSessionLimitUSD);

      const effectiveDailyCostLimit =
        defaultDailyLimitUSD === Infinity
          ? Infinity
          : defaultDailyLimitUSD + (state.dailyTopUpUSD[todayStr] || 0);

      // Check metrics for 90% threshold toast warning
      const dbMetrics = getOverviewMetrics();
      const sessionRow = queryDb((db) => {
        return db.query(`SELECT cost, tokens_input + tokens_output as totalTokens FROM session WHERE id = ?`).get(sessionId) as { cost: number; totalTokens: number } | null;
      }, { cost: 0, totalTokens: 0 });

      const currentSessionCost = sessionRow?.cost ?? 0;

      // 90% Toast Warning check
      if (sessionCostLimit !== Infinity && currentSessionCost / sessionCostLimit >= 0.90) {
        const pct = Math.round((currentSessionCost / sessionCostLimit) * 100);
        output.system.push(
          `[⚠️ Budget Warning Toast: Session cost is at ${pct}% of cap ($${currentSessionCost.toFixed(2)} / $${sessionCostLimit.toFixed(2)}). To override or extend, run "/budget-allowance 20" or "/budget-allowance off"]`
        );
      } else if (effectiveDailyCostLimit !== Infinity && dbMetrics.dailyCost / effectiveDailyCostLimit >= 0.90) {
        const pct = Math.round((dbMetrics.dailyCost / effectiveDailyCostLimit) * 100);
        output.system.push(
          `[⚠️ Budget Warning Toast: Daily cost is at ${pct}% of cap ($${dbMetrics.dailyCost.toFixed(2)} / $${effectiveDailyCostLimit.toFixed(2)}). To override or extend, run "/budget-allowance daily 30" or "/budget-allowance off"]`
        );
      } else if (sessionCostLimit !== Infinity || effectiveDailyCostLimit !== Infinity) {
        const costStr = sessionCostLimit === Infinity ? "Unlimited" : `$${sessionCostLimit.toFixed(2)}`;
        const dailyStr = effectiveDailyCostLimit === Infinity ? "Unlimited" : `$${effectiveDailyCostLimit.toFixed(2)}`;

        output.system.push(
          `[Opencode Budget Allowance Plugin Active] Model: ${modelName} | Session Limit: ${costStr} | Daily Limit: ${dailyStr} | Overrides File: ${statePath}`
        );
      }
    },

    "chat.params": async (params) => {
      const sessionId = params.sessionID || (params as any).sessionId || "";
      const rawModel = params.model;
      const modelName = typeof rawModel === "string" ? rawModel : (rawModel as any)?.id || "Active Model";
      const todayStr = new Date().toISOString().split("T")[0];

      // CRITICAL FIX: Bypass budget blocking if user's prompt is managing or overriding budget!
      const userMessageText = (params.message as any)?.content || (params.message as any)?.text || "";
      const isCommandOrOverridePrompt =
        userMessageText.includes("budget-allowance") ||
        userMessageText.includes("/budget") ||
        userMessageText.includes("override") ||
        userMessageText.includes("disable budget") ||
        userMessageText.includes("turn off budget");

      if (isCommandOrOverridePrompt) {
        // Allow the user to communicate with opencode to run override commands!
        return;
      }

      const state = loadState();
      const isSessionDisabled = state.disabledSessions[sessionId] === true;

      // Skip all checks if this session is explicitly disabled
      if (isSessionDisabled) {
        return;
      }

      // Determine model-specific defaults if configured
      const matchedCostKey = Object.keys(modelCostBudgets).find((k) =>
        modelName.toLowerCase().includes(k.toLowerCase())
      );
      const matchedTokenKey = Object.keys(modelTokenBudgets).find((k) =>
        modelName.toLowerCase().includes(k.toLowerCase())
      );

      const baseSessionCostCap =
        state.sessionCostLimits[sessionId]?.limit ??
        (matchedCostKey ? modelCostBudgets[matchedCostKey] : defaultSessionLimitUSD);

      const baseSessionTokenCap =
        state.sessionTokenLimits[sessionId]?.limit ??
        (matchedTokenKey ? modelTokenBudgets[matchedTokenKey] : defaultSessionTokenLimit);

      const effectiveDailyCostLimit =
        defaultDailyLimitUSD === Infinity
          ? Infinity
          : defaultDailyLimitUSD + (state.dailyTopUpUSD[todayStr] || 0);

      const effectiveDailyTokenLimit =
        defaultDailyTokenLimit === Infinity
          ? Infinity
          : defaultDailyTokenLimit + (state.dailyTopUpTokens[todayStr] || 0);

      // If no caps are active anywhere, return immediately
      if (
        baseSessionCostCap === Infinity &&
        baseSessionTokenCap === Infinity &&
        effectiveDailyCostLimit === Infinity &&
        effectiveDailyTokenLimit === Infinity
      ) {
        return;
      }

      // =======================================================================
      // QUERY METRICS FROM SQLITE
      // =======================================================================
      const startOfDayMs = new Date().setHours(0, 0, 0, 0);

      const dbMetrics = queryDb(
        (db) => {
          const dailyRow = db.query(`
            SELECT 
              COALESCE(SUM(cost), 0) AS dailyCost,
              COALESCE(SUM(tokens_input + tokens_output), 0) AS dailyTokens
            FROM session WHERE time_created >= ?
          `).get(startOfDayMs) as {
            dailyCost: number;
            dailyTokens: number;
          };

          const sessionRow = db.query(`
            SELECT cost, tokens_input, tokens_output FROM session WHERE id = ?
          `).get(sessionId) as { cost: number; tokens_input: number; tokens_output: number } | null;

          return {
            dailyCost: dailyRow?.dailyCost ?? 0,
            dailyTokens: dailyRow?.dailyTokens ?? 0,
            sessionCost: sessionRow?.cost ?? 0,
            sessionInputTokens: sessionRow?.tokens_input ?? 0,
            sessionTotalTokens: (sessionRow?.tokens_input ?? 0) + (sessionRow?.tokens_output ?? 0),
          };
        },
        {
          dailyCost: 0,
          dailyTokens: 0,
          sessionCost: 0,
          sessionInputTokens: 0,
          sessionTotalTokens: 0,
        }
      );

      // =======================================================================
      // CHECK 1: DAILY COST CEILING
      // =======================================================================
      if (effectiveDailyCostLimit !== Infinity && dbMetrics.dailyCost >= effectiveDailyCostLimit) {
        throw new Error(
          `\n🚨 [OPENCODE BUDGET ALLOWANCE PLUGIN BLOCK]\n` +
          `Daily spend limit reached ($${dbMetrics.dailyCost.toFixed(2)} / Cap $${effectiveDailyCostLimit.toFixed(2)}).\n\n` +
          `State Overrides File: ${statePath}\n\n` +
          `To fix or continue talking:\n` +
          `  1. Run slash command: /budget-allowance daily 25 (or /budget-allowance off)\n` +
          `  2. OR run the offline CLI tool: bun run /path/to/opencode-budget-allowance/src/cli.ts\n`
        );
      }

      // =======================================================================
      // CHECK 2: DAILY TOKEN CEILING
      // =======================================================================
      if (effectiveDailyTokenLimit !== Infinity && dbMetrics.dailyTokens >= effectiveDailyTokenLimit) {
        throw new Error(
          `\n🚨 [OPENCODE BUDGET ALLOWANCE PLUGIN BLOCK]\n` +
          `Daily token ceiling reached (${formatK(dbMetrics.dailyTokens)} / Ceiling ${formatK(effectiveDailyTokenLimit)}).\n\n` +
          `State Overrides File: ${statePath}\n\n` +
          `To fix or continue talking:\n` +
          `  1. Run slash command: /budget-allowance 2m (or /budget-allowance off)\n` +
          `  2. OR run the offline CLI tool: bun run /path/to/opencode-budget-allowance/src/cli.ts\n`
        );
      }

      // =======================================================================
      // CHECK 3: SESSION COST CEILING
      // =======================================================================
      if (baseSessionCostCap !== Infinity && dbMetrics.sessionCost >= baseSessionCostCap) {
        throw new Error(
          `\n🚨 [OPENCODE BUDGET ALLOWANCE PLUGIN BLOCK]\n` +
          `Session budget limit reached for ${modelName} ($${dbMetrics.sessionCost.toFixed(2)} / Limit $${baseSessionCostCap.toFixed(2)}).\n\n` +
          `State Overrides File: ${statePath}\n\n` +
          `To fix or continue talking:\n` +
          `  1. Run slash command: /budget-allowance 15 (or /budget-allowance off)\n` +
          `  2. OR run the offline CLI tool: bun run /path/to/opencode-budget-allowance/src/cli.ts\n`
        );
      }

      // =======================================================================
      // CHECK 4: SESSION TOKEN CEILING
      // =======================================================================
      if (baseSessionTokenCap !== Infinity && dbMetrics.sessionTotalTokens >= baseSessionTokenCap) {
        throw new Error(
          `\n🚨 [OPENCODE BUDGET ALLOWANCE PLUGIN BLOCK]\n` +
          `Session token limit reached for ${modelName} (${formatK(dbMetrics.sessionTotalTokens)} / Limit ${formatK(baseSessionTokenCap)}).\n\n` +
          `State Overrides File: ${statePath}\n\n` +
          `To fix or continue talking:\n` +
          `  1. Run slash command: /budget-allowance 500k (or /budget-allowance off)\n` +
          `  2. OR run the offline CLI tool: bun run /path/to/opencode-budget-allowance/src/cli.ts\n`
        );
      }

      // =======================================================================
      // AUTO-COMPACTION
      // =======================================================================
      if (dbMetrics.sessionInputTokens >= compactAtInputTokens) {
        try {
          if (client?.session?.compact) {
            await client.session.compact({ path: { id: sessionId } });
          }
        } catch {
          // Silent fallback
        }
      }
    },
  };
}) satisfies Plugin;
