import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";
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
  modelCostBudgets?: Record<string, number>;  // Per-model cost limits, supports "model" or "provider/model"
  modelTokenBudgets?: Record<string, number>; // Per-model token limits, supports "model" or "provider/model"
  providerCostBudgets?: Record<string, number>;  // Per-provider cost limits { "anthropic": 20.0, "xai": 5.0 }
  providerTokenBudgets?: Record<string, number>; // Per-provider token limits { "anthropic": 500000 }
  providerModelCostBudgets?: Record<string, Record<string, number>>; // Provider-specific model cost limits { "anthropic": { "claude-3-7-sonnet": 10.0 } }
  providerModelTokenBudgets?: Record<string, Record<string, number>>; // Provider-specific model token limits { "anthropic": { "claude-3-7-sonnet": 500000 } }
}

export interface TopUpRecord {
  id: string;
  timestamp: number;
  dateStr: string;
  sessionId: string;
  model: string;
  scope: "daily" | "session" | "global";
  type: "cost" | "token" | "disable" | "enable";
  amount: number;
}

export interface BudgetState {
  dailyTopUpUSD: Record<string, number>;
  dailyTopUpTokens: Record<string, number>;
  sessionCostLimits: Record<string, { limit: number; model: string }>;
  sessionTokenLimits: Record<string, { limit: number; model: string }>;
  disabledSessions: Record<string, boolean>;
  globalDisabled: boolean;
  history: TopUpRecord[];
}

// ============================================================================
// PATHS & CONSTANTS
// ============================================================================

export const dbPath = path.join(os.homedir(), ".local/share/opencode/opencode.db");
export const statePath = path.join(os.homedir(), ".config/opencode/budget-overrides.json");
export const cliPath = path.join(os.homedir(), ".config/opencode/plugins/cli.ts");

// Compact number formatter (610k, 1.2M)
export function formatK(num: number): string {
  if (num === Infinity || num < 0 || isNaN(num)) return "∞";
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
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
        globalDisabled: parsed.globalDisabled === true,
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
    globalDisabled: false,
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
// MODEL & PROVIDER RESOLVER
// ============================================================================

export function resolveModelAndProvider(rawModel: any, providerInfo: any): {
  providerId: string;
  modelId: string;
  fullModelKey: string;
  displayName: string;
} {
  let providerId = "";
  let modelId = "";

  if (typeof rawModel === "string") {
    if (rawModel.includes("/")) {
      const parts = rawModel.split("/");
      providerId = parts[0].toLowerCase();
      modelId = parts.slice(1).join("/").toLowerCase();
    } else {
      modelId = rawModel.toLowerCase();
    }
  } else if (rawModel && typeof rawModel === "object") {
    modelId = (rawModel.id || rawModel.modelID || rawModel.name || "").toLowerCase();
    providerId = (rawModel.providerID || rawModel.provider || "").toLowerCase();
    if (!providerId && modelId.includes("/")) {
      const parts = modelId.split("/");
      providerId = parts[0];
      modelId = parts.slice(1).join("/");
    }
  }

  if (!providerId && providerInfo) {
    providerId = (providerInfo?.info?.id || providerInfo?.id || providerInfo?.source || "").toLowerCase();
  }

  const fullModelKey = providerId && modelId ? `${providerId}/${modelId}` : modelId || providerId;
  const displayName = fullModelKey || "Active Model";

  return { providerId, modelId, fullModelKey, displayName };
}

export function findMatchingLimit(
  map: Record<string, number> | undefined,
  keys: string[]
): number | undefined {
  if (!map) return undefined;
  for (const key of keys) {
    if (!key) continue;
    // Exact match
    if (map[key] !== undefined) return map[key];
    // Case-insensitive / partial match
    const found = Object.keys(map).find(
      (k) => k.toLowerCase() === key.toLowerCase() || key.toLowerCase().includes(k.toLowerCase())
    );
    if (found && map[found] !== undefined) return map[found];
  }
  return undefined;
}

// ============================================================================
// PLUGIN MAIN EXPORT
// ============================================================================

export default {
  id: "opencode-budget-allowance",
  server: (async ({ client }: any, options: BudgetOptions = {}) => {
    const {
      defaultDailyLimitUSD = Infinity,
      defaultSessionLimitUSD = Infinity,
      defaultDailyTokenLimit = Infinity,
      defaultSessionTokenLimit = Infinity,
      compactAtInputTokens = 120_000,
      modelCostBudgets = {},
      modelTokenBudgets = {},
      providerCostBudgets = {},
      providerTokenBudgets = {},
      providerModelCostBudgets = {},
      providerModelTokenBudgets = {},
    } = options;

    return {
      "shell.env": async (input: any, output: any) => {
        if (input?.sessionID) {
          output.env = output.env || {};
          output.env.OPENCODE_SESSION_ID = input.sessionID;
        }
      },

      "experimental.chat.system.transform": async (input: any, output: any) => {
        const sessionId = input?.sessionID || "";
        const state = loadState();
        const isSessionDisabled = state.disabledSessions[sessionId] === true;
        const todayStr = new Date().toISOString().split("T")[0];
        const dailyTopUpUSD = state.dailyTopUpUSD[todayStr] || 0;
        const dailyTopUpTokens = state.dailyTopUpTokens[todayStr] || 0;
        const sessionCostLimit = state.sessionCostLimits[sessionId]?.limit;
        const sessionTokenLimit = state.sessionTokenLimits[sessionId]?.limit;

        output.system = output.system || [];
        if (state.globalDisabled === true) {
          output.system.push("[Budget Status: ALL budget limits and checks are GLOBALLY DISABLED]");
        } else if (isSessionDisabled) {
          output.system.push("[Budget Status: Session budget checks are DISABLED for this session]");
        } else {
          const parts: string[] = [];
          if (sessionCostLimit !== undefined) {
            parts.push(`Session Cost Cap: $${sessionCostLimit.toFixed(2)}`);
          }
          if (sessionTokenLimit !== undefined) {
            parts.push(`Session Token Cap: ${formatK(sessionTokenLimit)}`);
          }
          if (defaultDailyLimitUSD !== Infinity || dailyTopUpUSD > 0) {
            const cap = (defaultDailyLimitUSD === Infinity ? 0 : defaultDailyLimitUSD) + dailyTopUpUSD;
            parts.push(`Daily Cost Cap: $${cap.toFixed(2)}`);
          }
          if (defaultDailyTokenLimit !== Infinity || dailyTopUpTokens > 0) {
            const cap = (defaultDailyTokenLimit === Infinity ? 0 : defaultDailyTokenLimit) + dailyTopUpTokens;
            parts.push(`Daily Token Cap: ${formatK(cap)}`);
          }
          if (parts.length > 0) {
            output.system.push(`[Budget Allowance: ${parts.join(" | ")}]`);
          }
        }
      },

      // Custom tools exposed directly to OpenCode agents
      tool: {
        budget_get_status: tool({
          description: "Get today's LLM spend overview, tokens used, active caps, and session/global budget status without editing any files.",
          args: {},
          async execute(_args, context) {
            const state = loadState();
            const metrics = getOverviewMetrics();
            const todayStr = new Date().toISOString().split("T")[0];
            const sessionId = context?.sessionID || "";

            const dailyTopUpUSD = state.dailyTopUpUSD[todayStr] || 0;
            const dailyTopUpTokens = state.dailyTopUpTokens[todayStr] || 0;
            const isSessionDisabled = state.disabledSessions[sessionId] === true;
            const sessionCostCap = state.sessionCostLimits[sessionId]?.limit;
            const sessionTokenCap = state.sessionTokenLimits[sessionId]?.limit;

            let result = `=== OpenCode Budget Allowance Status (${todayStr}) ===\n`;
            result += `• Today's Total Cost Spent: $${metrics.dailyCost.toFixed(2)}\n`;
            result += `• Today's Tokens Used: ${metrics.dailyTokens.toLocaleString()}\n`;
            result += `• Active Sessions Today: ${metrics.sessionCount}\n`;
            result += `• Average Cost / Session: $${metrics.avgCost.toFixed(2)}\n\n`;

            result += `Global Status:\n`;
            if (state.globalDisabled === true) {
              result += `• Budget Checks: GLOBALLY DISABLED (no limits enforced anywhere)\n\n`;
            } else {
              result += `• Budget Checks: Active (limits enforced)\n`;
              result += `• Daily Cost Top-Up: ${dailyTopUpUSD > 0 ? `+$${dailyTopUpUSD.toFixed(2)}` : "None"}\n`;
              if (dailyTopUpTokens > 0) {
                result += `• Daily Token Top-Up: +${formatK(dailyTopUpTokens)}\n`;
              }
              result += `\n`;
            }

            if (sessionId) {
              result += `Current Session (${sessionId}):\n`;
              if (state.globalDisabled === true) {
                result += `• Status: Bypassed (Global Disable is active)\n`;
              } else if (isSessionDisabled) {
                result += `• Status: Budget checks DISABLED for this session\n`;
              } else if (sessionCostCap !== undefined) {
                result += `• Session Cost Cap: $${sessionCostCap.toFixed(2)}\n`;
              } else if (sessionTokenCap !== undefined) {
                result += `• Session Token Cap: ${formatK(sessionTokenCap)}\n`;
              } else {
                result += `• Session Cap: None (unlimited)\n`;
              }
            }

            return result;
          },
        }),

        budget_set_limit: tool({
          description: "Set a dollar cost or token budget limit for the current session or add to the global daily allowance.",
          args: {
            amount: tool.schema.number().describe("The budget limit amount (e.g. 15 for $15, or 500000 for 500k tokens)"),
            type: tool.schema.enum(["cost", "token"]).default("cost").describe("Whether this limit is cost (USD) or token count"),
            scope: tool.schema.enum(["session", "daily"]).default("session").describe("Whether to apply to active session or today's daily limit"),
          },
          async execute(args, context) {
            const state = loadState();
            const todayStr = new Date().toISOString().split("T")[0];
            const sessionId = context?.sessionID || process.env.OPENCODE_SESSION_ID || "ACTIVE_SESSION";

            if (args.scope === "daily") {
              if (args.type === "cost") {
                state.dailyTopUpUSD[todayStr] = (state.dailyTopUpUSD[todayStr] || 0) + args.amount;
                state.history.push({
                  id: `tool_${Date.now()}`,
                  timestamp: Date.now(),
                  dateStr: todayStr,
                  sessionId: "GLOBAL_DAILY",
                  model: "AI_TOOL",
                  scope: "daily",
                  type: "cost",
                  amount: args.amount,
                });
                saveState(state);
                return `✅ Added +$${args.amount.toFixed(2)} to daily budget allowance for ${todayStr}.`;
              } else {
                state.dailyTopUpTokens[todayStr] = (state.dailyTopUpTokens[todayStr] || 0) + args.amount;
                state.history.push({
                  id: `tool_${Date.now()}`,
                  timestamp: Date.now(),
                  dateStr: todayStr,
                  sessionId: "GLOBAL_DAILY",
                  model: "AI_TOOL",
                  scope: "daily",
                  type: "token",
                  amount: args.amount,
                });
                saveState(state);
                return `✅ Added +${formatK(args.amount)} tokens to daily budget allowance for ${todayStr}.`;
              }
            } else {
              delete state.disabledSessions[sessionId];
              if (args.type === "cost") {
                state.sessionCostLimits[sessionId] = { limit: args.amount, model: "AI_TOOL" };
                state.history.push({
                  id: `tool_${Date.now()}`,
                  timestamp: Date.now(),
                  dateStr: todayStr,
                  sessionId,
                  model: "AI_TOOL",
                  scope: "session",
                  type: "cost",
                  amount: args.amount,
                });
                saveState(state);
                return `✅ Set session cost budget cap to $${args.amount.toFixed(2)} for session ${sessionId}.`;
              } else {
                state.sessionTokenLimits[sessionId] = { limit: args.amount, model: "AI_TOOL" };
                state.history.push({
                  id: `tool_${Date.now()}`,
                  timestamp: Date.now(),
                  dateStr: todayStr,
                  sessionId,
                  model: "AI_TOOL",
                  scope: "session",
                  type: "token",
                  amount: args.amount,
                });
                saveState(state);
                return `✅ Set session token budget cap to ${formatK(args.amount)} tokens for session ${sessionId}.`;
              }
            }
          },
        }),

        budget_disable: tool({
          description: "Disable budget checks for the active session or globally across all sessions.",
          args: {
            scope: tool.schema.enum(["session", "global"]).default("session").describe("Whether to disable for the active session only or globally"),
          },
          async execute(args, context) {
            const state = loadState();
            const todayStr = new Date().toISOString().split("T")[0];
            const sessionId = context?.sessionID || process.env.OPENCODE_SESSION_ID || "ACTIVE_SESSION";

            if (args.scope === "global") {
              state.globalDisabled = true;
              state.history.push({
                id: `tool_${Date.now()}`,
                timestamp: Date.now(),
                dateStr: todayStr,
                sessionId: "GLOBAL_ALL",
                model: "AI_TOOL",
                scope: "global",
                type: "disable",
                amount: 0,
              });
              saveState(state);
              return `✅ All budget checks and limits are now GLOBALLY DISABLED for all sessions.`;
            } else {
              state.disabledSessions[sessionId] = true;
              state.history.push({
                id: `tool_${Date.now()}`,
                timestamp: Date.now(),
                dateStr: todayStr,
                sessionId,
                model: "AI_TOOL",
                scope: "session",
                type: "disable",
                amount: 0,
              });
              saveState(state);
              return `✅ Budget checks disabled for session ${sessionId}.`;
            }
          },
        }),

        budget_enable: tool({
          description: "Re-enable budget checks for the active session or globally across all sessions.",
          args: {
            scope: tool.schema.enum(["session", "global"]).default("session").describe("Whether to re-enable for the active session only or globally"),
          },
          async execute(args, context) {
            const state = loadState();
            const todayStr = new Date().toISOString().split("T")[0];
            const sessionId = context?.sessionID || process.env.OPENCODE_SESSION_ID || "ACTIVE_SESSION";

            if (args.scope === "global") {
              state.globalDisabled = false;
              state.history.push({
                id: `tool_${Date.now()}`,
                timestamp: Date.now(),
                dateStr: todayStr,
                sessionId: "GLOBAL_ALL",
                model: "AI_TOOL",
                scope: "global",
                type: "enable",
                amount: 0,
              });
              saveState(state);
              return `✅ Global budget checks RE-ENABLED. Session and daily limits are now active.`;
            } else {
              delete state.disabledSessions[sessionId];
              state.history.push({
                id: `tool_${Date.now()}`,
                timestamp: Date.now(),
                dateStr: todayStr,
                sessionId,
                model: "AI_TOOL",
                scope: "session",
                type: "enable",
                amount: 0,
              });
              saveState(state);
              return `✅ Budget checks re-enabled for session ${sessionId}.`;
            }
          },
        }),
      },

      "chat.params": async (params: any) => {
        const sessionId = params.sessionID || (params as any).sessionId || "";
        const rawModel = params.model;
        const providerInfo = (params as any).provider;
        const todayStr = new Date().toISOString().split("T")[0];

        // Bypass budget blocking if user's prompt is managing or overriding budget!
        const userMessageText = (params.message as any)?.content || (params.message as any)?.text || "";
        const textLower = typeof userMessageText === "string" ? userMessageText.toLowerCase() : "";
        const isCommandOrOverridePrompt =
          textLower.includes("budget") ||
          textLower.includes("allowance") ||
          textLower.includes("allocate") ||
          textLower.includes("override") ||
          textLower.includes("disable budget") ||
          textLower.includes("turn off budget");

        if (isCommandOrOverridePrompt) {
          return;
        }

        const state = loadState();

        // Check if globally disabled
        if (state.globalDisabled === true) {
          return;
        }

        // Check if session disabled
        if (state.disabledSessions[sessionId] === true) {
          return;
        }

        const { providerId, modelId, fullModelKey, displayName } = resolveModelAndProvider(
          rawModel,
          providerInfo
        );

        // Resolve Provider-Specific Model Cost Cap:
        // 1. providerModelCostBudgets[providerId][modelId]
        // 2. modelCostBudgets["provider/model"]
        // 3. modelCostBudgets["model"]
        // 4. providerCostBudgets["provider"]
        // 5. defaultSessionLimitUSD
        const providerNestedCost = providerId && providerModelCostBudgets[providerId]
          ? findMatchingLimit(providerModelCostBudgets[providerId], [modelId, fullModelKey])
          : undefined;

        const baseSessionCostCap =
          state.sessionCostLimits[sessionId]?.limit ??
          providerNestedCost ??
          findMatchingLimit(modelCostBudgets, [fullModelKey, modelId]) ??
          findMatchingLimit(providerCostBudgets, [providerId]) ??
          defaultSessionLimitUSD;

        // Resolve Provider-Specific Model Token Cap:
        const providerNestedToken = providerId && providerModelTokenBudgets[providerId]
          ? findMatchingLimit(providerModelTokenBudgets[providerId], [modelId, fullModelKey])
          : undefined;

        const baseSessionTokenCap =
          state.sessionTokenLimits[sessionId]?.limit ??
          providerNestedToken ??
          findMatchingLimit(modelTokenBudgets, [fullModelKey, modelId]) ??
          findMatchingLimit(providerTokenBudgets, [providerId]) ??
          defaultSessionTokenLimit;

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

        const cliCmd = `bun run ${cliPath}`;

        // =======================================================================
        // CHECK 1: DAILY COST CEILING
        // =======================================================================
        if (effectiveDailyCostLimit !== Infinity && dbMetrics.dailyCost >= effectiveDailyCostLimit) {
          throw new Error(
            `\n🚨 [OPENCODE BUDGET ALLOWANCE PLUGIN BLOCK]\n` +
            `Daily spend limit reached ($${dbMetrics.dailyCost.toFixed(2)} / Cap $${effectiveDailyCostLimit.toFixed(2)}).\n\n` +
            `State Overrides File: ${statePath}\n\n` +
            `To fix or continue talking:\n` +
            `  1. Run slash command: /budget daily 25 (or /budget off global)\n` +
            `  2. OR run offline CLI tool: ${cliCmd}\n`
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
            `  1. Run slash command: /budget 2m (or /budget off global)\n` +
            `  2. OR run offline CLI tool: ${cliCmd}\n`
          );
        }

        // =======================================================================
        // CHECK 3: SESSION COST CEILING
        // =======================================================================
        if (baseSessionCostCap !== Infinity && dbMetrics.sessionCost >= baseSessionCostCap) {
          throw new Error(
            `\n🚨 [OPENCODE BUDGET ALLOWANCE PLUGIN BLOCK]\n` +
            `Session budget limit reached for ${displayName} ($${dbMetrics.sessionCost.toFixed(2)} / Limit $${baseSessionCostCap.toFixed(2)}).\n\n` +
            `State Overrides File: ${statePath}\n\n` +
            `To fix or continue talking:\n` +
            `  1. Run slash command: /budget 15 (or /budget off)\n` +
            `  2. OR run offline CLI tool: ${cliCmd}\n`
          );
        }

        // =======================================================================
        // CHECK 4: SESSION TOKEN CEILING
        // =======================================================================
        if (baseSessionTokenCap !== Infinity && dbMetrics.sessionTotalTokens >= baseSessionTokenCap) {
          throw new Error(
            `\n🚨 [OPENCODE BUDGET ALLOWANCE PLUGIN BLOCK]\n` +
            `Session token limit reached for ${displayName} (${formatK(dbMetrics.sessionTotalTokens)} / Limit ${formatK(baseSessionTokenCap)}).\n\n` +
            `State Overrides File: ${statePath}\n\n` +
            `To fix or continue talking:\n` +
            `  1. Run slash command: /budget 500k (or /budget off)\n` +
            `  2. OR run offline CLI tool: ${cliCmd}\n`
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
  }) satisfies Plugin,
} satisfies PluginModule;
