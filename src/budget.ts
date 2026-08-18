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

export function getSessionMetrics(sessionId: string) {
  return queryDb(
    (db) => {
      const sessionRow = db.query(`
        SELECT cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, title, time_created, time_updated
        FROM session WHERE id = ?
      `).get(sessionId) as {
        cost: number;
        tokens_input: number;
        tokens_output: number;
        tokens_cache_read: number;
        tokens_cache_write: number;
        title: string | null;
        time_created: number;
        time_updated: number;
      } | null;

      if (!sessionRow) {
        return {
          cost: 0,
          tokensInput: 0,
          tokensOutput: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          totalTokens: 0,
          title: "",
          exists: false,
        };
      }

      const totalTokens = (sessionRow.tokens_input || 0) + (sessionRow.tokens_output || 0);
      return {
        cost: sessionRow.cost || 0,
        tokensInput: sessionRow.tokens_input || 0,
        tokensOutput: sessionRow.tokens_output || 0,
        tokensCacheRead: sessionRow.tokens_cache_read || 0,
        tokensCacheWrite: sessionRow.tokens_cache_write || 0,
        totalTokens,
        title: sessionRow.title || "",
        exists: true,
      };
    },
    {
      cost: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      totalTokens: 0,
      title: "",
      exists: false,
    }
  );
}

export function getEffectiveDailyLimits(state: BudgetState, options: BudgetOptions, todayStr: string) {
  const { defaultDailyLimitUSD = Infinity, defaultDailyTokenLimit = Infinity } = options;
  const dailyTopUpUSD = state.dailyTopUpUSD[todayStr] || 0;
  const dailyTopUpTokens = state.dailyTopUpTokens[todayStr] || 0;

  const hasConfigDailyCost = defaultDailyLimitUSD !== undefined && defaultDailyLimitUSD !== Infinity;
  const effectiveDailyCostLimit = hasConfigDailyCost
    ? defaultDailyLimitUSD + dailyTopUpUSD
    : dailyTopUpUSD > 0 ? dailyTopUpUSD : Infinity;

  const hasConfigDailyTokens = defaultDailyTokenLimit !== undefined && defaultDailyTokenLimit !== Infinity;
  const effectiveDailyTokenLimit = hasConfigDailyTokens
    ? defaultDailyTokenLimit + dailyTopUpTokens
    : dailyTopUpTokens > 0 ? dailyTopUpTokens : Infinity;

  return {
    effectiveDailyCostLimit,
    effectiveDailyTokenLimit,
    dailyTopUpUSD,
    dailyTopUpTokens,
    baseDailyCost: hasConfigDailyCost ? defaultDailyLimitUSD : 0,
    baseDailyTokens: hasConfigDailyTokens ? defaultDailyTokenLimit : 0,
  };
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
// BUDGET LIMIT CHECKER
// ============================================================================

export interface BudgetCheckStatus {
  hardStopReason: string | null;
  warningReason: string | null;
}

export function checkBudgetStatus(
  sessionId: string,
  modelName: string,
  providerId: string,
  modelId: string,
  fullModelKey: string,
  options: BudgetOptions
): BudgetCheckStatus {
  const state = loadState();
  if (state.globalDisabled === true) return { hardStopReason: null, warningReason: null };
  if (sessionId && state.disabledSessions[sessionId] === true) return { hardStopReason: null, warningReason: null };

  const todayStr = new Date().toISOString().split("T")[0];
  const {
    defaultSessionLimitUSD = Infinity,
    defaultSessionTokenLimit = Infinity,
    modelCostBudgets = {},
    modelTokenBudgets = {},
    providerCostBudgets = {},
    providerTokenBudgets = {},
    providerModelCostBudgets = {},
    providerModelTokenBudgets = {},
  } = options;

  const providerNestedCost = providerId && providerModelCostBudgets[providerId]
    ? findMatchingLimit(providerModelCostBudgets[providerId], [modelId, fullModelKey])
    : undefined;

  const baseSessionCostCap =
    (sessionId ? state.sessionCostLimits[sessionId]?.limit : undefined) ??
    providerNestedCost ??
    findMatchingLimit(modelCostBudgets, [fullModelKey, modelId]) ??
    findMatchingLimit(providerCostBudgets, [providerId]) ??
    defaultSessionLimitUSD;

  const providerNestedToken = providerId && providerModelTokenBudgets[providerId]
    ? findMatchingLimit(providerModelTokenBudgets[providerId], [modelId, fullModelKey])
    : undefined;

  const baseSessionTokenCap =
    (sessionId ? state.sessionTokenLimits[sessionId]?.limit : undefined) ??
    providerNestedToken ??
    findMatchingLimit(modelTokenBudgets, [fullModelKey, modelId]) ??
    findMatchingLimit(providerTokenBudgets, [providerId]) ??
    defaultSessionTokenLimit;

  const { effectiveDailyCostLimit, effectiveDailyTokenLimit } = getEffectiveDailyLimits(state, options, todayStr);

  if (
    baseSessionCostCap === Infinity &&
    baseSessionTokenCap === Infinity &&
    effectiveDailyCostLimit === Infinity &&
    effectiveDailyTokenLimit === Infinity
  ) {
    return { hardStopReason: null, warningReason: null };
  }

  const startOfDayMs = new Date().setHours(0, 0, 0, 0);
  const dbMetrics = queryDb(
    (db) => {
      const dailyRow = db.query(`
        SELECT 
          COALESCE(SUM(cost), 0) AS dailyCost,
          COALESCE(SUM(tokens_input + tokens_output), 0) AS dailyTokens
        FROM session WHERE time_created >= ?
      `).get(startOfDayMs) as { dailyCost: number; dailyTokens: number } | null;

      let sessionCost = 0;
      let sessionTotalTokens = 0;

      if (sessionId) {
        const sessionRow = db.query(`
          SELECT cost, tokens_input, tokens_output FROM session WHERE id = ?
        `).get(sessionId) as { cost: number; tokens_input: number; tokens_output: number } | null;
        sessionCost = sessionRow?.cost ?? 0;
        sessionTotalTokens = (sessionRow?.tokens_input ?? 0) + (sessionRow?.tokens_output ?? 0);
      }

      return {
        dailyCost: dailyRow?.dailyCost ?? 0,
        dailyTokens: dailyRow?.dailyTokens ?? 0,
        sessionCost,
        sessionTotalTokens,
      };
    },
    { dailyCost: 0, dailyTokens: 0, sessionCost: 0, sessionTotalTokens: 0 }
  );

  let hardStopReason: string | null = null;
  let warningReason: string | null = null;

  // 1. Check Hard Stops (100% threshold reached or exceeded)
  if (effectiveDailyCostLimit !== Infinity && dbMetrics.dailyCost >= effectiveDailyCostLimit) {
    hardStopReason = `Daily cost limit reached ($${dbMetrics.dailyCost.toFixed(2)} / Cap $${effectiveDailyCostLimit.toFixed(2)})`;
  } else if (effectiveDailyTokenLimit !== Infinity && dbMetrics.dailyTokens >= effectiveDailyTokenLimit) {
    hardStopReason = `Daily token ceiling reached (${formatK(dbMetrics.dailyTokens)} / Ceiling ${formatK(effectiveDailyTokenLimit)})`;
  } else if (sessionId && baseSessionCostCap !== Infinity && dbMetrics.sessionCost >= baseSessionCostCap) {
    hardStopReason = `Session cost limit reached for ${modelName || "active model"} ($${dbMetrics.sessionCost.toFixed(2)} / Limit $${baseSessionCostCap.toFixed(2)})`;
  } else if (sessionId && baseSessionTokenCap !== Infinity && dbMetrics.sessionTotalTokens >= baseSessionTokenCap) {
    hardStopReason = `Session token limit reached for ${modelName || "active model"} (${formatK(dbMetrics.sessionTotalTokens)} / Limit ${formatK(baseSessionTokenCap)})`;
  }

  // 2. Check Warnings (90% threshold reached, but not yet 100%)
  if (!hardStopReason) {
    if (effectiveDailyCostLimit !== Infinity && dbMetrics.dailyCost >= 0.9 * effectiveDailyCostLimit) {
      const pct = ((dbMetrics.dailyCost / effectiveDailyCostLimit) * 100).toFixed(1);
      warningReason = `Daily cost at ${pct}% ($${dbMetrics.dailyCost.toFixed(2)} / Cap $${effectiveDailyCostLimit.toFixed(2)})`;
    } else if (effectiveDailyTokenLimit !== Infinity && dbMetrics.dailyTokens >= 0.9 * effectiveDailyTokenLimit) {
      const pct = ((dbMetrics.dailyTokens / effectiveDailyTokenLimit) * 100).toFixed(1);
      warningReason = `Daily token usage at ${pct}% (${formatK(dbMetrics.dailyTokens)} / Ceiling ${formatK(effectiveDailyTokenLimit)})`;
    } else if (sessionId && baseSessionCostCap !== Infinity && dbMetrics.sessionCost >= 0.9 * baseSessionCostCap) {
      const pct = ((dbMetrics.sessionCost / baseSessionCostCap) * 100).toFixed(1);
      warningReason = `Session cost at ${pct}% for ${modelName || "active model"} ($${dbMetrics.sessionCost.toFixed(2)} / Limit $${baseSessionCostCap.toFixed(2)})`;
    } else if (sessionId && baseSessionTokenCap !== Infinity && dbMetrics.sessionTotalTokens >= 0.9 * baseSessionTokenCap) {
      const pct = ((dbMetrics.sessionTotalTokens / baseSessionTokenCap) * 100).toFixed(1);
      warningReason = `Session token usage at ${pct}% for ${modelName || "active model"} (${formatK(dbMetrics.sessionTotalTokens)} / Limit ${formatK(baseSessionTokenCap)})`;
    }
  }

  return { hardStopReason, warningReason };
}

export function checkBudgetExceeded(
  sessionId: string,
  modelName: string,
  providerId: string,
  modelId: string,
  fullModelKey: string,
  options: BudgetOptions
): string | null {
  return checkBudgetStatus(sessionId, modelName, providerId, modelId, fullModelKey, options).hardStopReason;
}

// ============================================================================
// PLUGIN MAIN EXPORT
// ============================================================================

export default {
  id: "opencode-budget-allowance",
  server: (async ({ client }: any, options: BudgetOptions = {}) => {
    const {
      compactAtInputTokens = 120_000,
    } = options;

    // Track sessions currently managing budget so we never block them
    const managingSessions = new Set<string>();

    return {
      "shell.env": async (input: any, output: any) => {
        if (input?.sessionID) {
          output.env = output.env || {};
          output.env.OPENCODE_SESSION_ID = input.sessionID;
        }
      },

      "command.execute.before": async (input: any) => {
        if (input?.command?.includes("budget") || input?.command?.includes("allocate")) {
          if (input?.sessionID) {
            managingSessions.add(input.sessionID);
          }
        }
      },

      "chat.message": async (input: any, output: any) => {
        const sessionId = input?.sessionID || "";
        const parts = output?.parts || [];
        const text = parts
          .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
          .map((p: any) => p.text)
          .join(" ")
          .toLowerCase();

        if (
          text.includes("budget") ||
          text.includes("allowance") ||
          text.includes("allocate") ||
          text.includes("override") ||
          text.includes("disable budget") ||
          text.includes("turn off budget") ||
          text.includes("off global") ||
          text.includes("/budget")
        ) {
          if (sessionId) managingSessions.add(sessionId);
        } else {
          if (sessionId) managingSessions.delete(sessionId);
        }
      },

      "experimental.chat.system.transform": async (input: any, output: any) => {
        const sessionId = input?.sessionID || "";
        const state = loadState();
        const isSessionDisabled = sessionId ? state.disabledSessions[sessionId] === true : false;
        const todayStr = new Date().toISOString().split("T")[0];
        const { effectiveDailyCostLimit, effectiveDailyTokenLimit } = getEffectiveDailyLimits(state, options, todayStr);
        const sessionCostLimit = sessionId ? state.sessionCostLimits[sessionId]?.limit : undefined;
        const sessionTokenLimit = sessionId ? state.sessionTokenLimits[sessionId]?.limit : undefined;

        output.system = output.system || [];

        if (state.globalDisabled === true) {
          output.system.push("[Budget Status: ALL budget limits and checks are GLOBALLY DISABLED]");
          return;
        }

        if (isSessionDisabled) {
          output.system.push("[Budget Status: Session budget checks are DISABLED for this session]");
          return;
        }

        const { providerId, modelId, fullModelKey, displayName } = resolveModelAndProvider(
          input?.model,
          undefined
        );

        const { hardStopReason, warningReason } = checkBudgetStatus(
          sessionId,
          displayName,
          providerId,
          modelId,
          fullModelKey,
          options
        );

        if (hardStopReason) {
          output.system.push(
            `🛑 [BUDGET LIMIT EXCEEDED: 100% HARD STOP - ${hardStopReason}]\n` +
            `The user has reached 100% of their budget limit.\n` +
            `You MUST immediately STOP all work, code generation, file editing, and tool execution.\n` +
            `You MUST state clearly that the budget limit has been reached (100% hard stop) and cite that the user must use the offline terminal CLI to adjust, top-up, or disable their budget allowance:\n` +
            `  bun run ~/.config/opencode/plugins/cli.ts\n` +
            `Do NOT perform any coding or project tasks until the budget is updated via the CLI.`
          );
        } else if (warningReason) {
          output.system.push(
            `⚠️ [BUDGET WARNING: 90% THRESHOLD REACHED - ${warningReason}]\n` +
            `The user has reached 90% or more of their budget allowance.\n` +
            `You MUST proactively warn the user about their current spend and that they are approaching their limit (${warningReason}).\n` +
            `You MUST ask the user what they would like to do before continuing:\n` +
            `  1. Continue working until the 100% hard stop is reached\n` +
            `  2. Increase or adjust the budget limit using the offline CLI (bun run ~/.config/opencode/plugins/cli.ts) or /budget command\n` +
            `  3. Disable budget limits for this session (/budget off)`
          );
        } else {
          const parts: string[] = [];
          if (sessionCostLimit !== undefined && sessionCostLimit !== Infinity) {
            parts.push(`Session Cost Cap: $${sessionCostLimit.toFixed(2)}`);
          }
          if (sessionTokenLimit !== undefined && sessionTokenLimit !== Infinity) {
            parts.push(`Session Token Cap: ${formatK(sessionTokenLimit)}`);
          }
          if (effectiveDailyCostLimit !== Infinity) {
            parts.push(`Daily Cost Cap: $${effectiveDailyCostLimit.toFixed(2)}`);
          }
          if (effectiveDailyTokenLimit !== Infinity) {
            parts.push(`Daily Token Cap: ${formatK(effectiveDailyTokenLimit)}`);
          }
          if (parts.length > 0) {
            output.system.push(`[Budget Allowance: ${parts.join(" | ")}]`);
          }
        }
      },

      // Intercept modifying tools if budget is exceeded (100% hard stop)
      "tool.execute.before": async (input: any) => {
        // Never block budget management tools
        if (input?.tool?.startsWith("budget_")) {
          return;
        }

        const sessionId = input?.sessionID || "";
        const state = loadState();
        if (state.globalDisabled === true) return;
        if (sessionId && state.disabledSessions[sessionId] === true) return;

        const { hardStopReason } = checkBudgetStatus(
          sessionId,
          "active model",
          "",
          "",
          "",
          options
        );

        if (hardStopReason) {
          throw new Error(
            `[Budget Limit Reached: 100% HARD STOP] Execution of tool '${input.tool}' is blocked because ${hardStopReason}.\n` +
            `All tool actions are stopped. Please use the offline terminal CLI to adjust your budget or disable limits:\n` +
            `  bun run ~/.config/opencode/plugins/cli.ts`
          );
        }
      },

      // Custom tools exposed directly to OpenCode agents
      tool: {
        budget_get_status: tool({
          description: "Get today's LLM spend overview, tokens used, active caps, remaining/pending balances, and session/global budget status without editing any files.",
          args: {},
          async execute(_args, context) {
            const state = loadState();
            const metrics = getOverviewMetrics();
            const todayStr = new Date().toISOString().split("T")[0];
            const sessionId = context?.sessionID || process.env.OPENCODE_SESSION_ID || "";

            const { effectiveDailyCostLimit, effectiveDailyTokenLimit, dailyTopUpUSD, dailyTopUpTokens } =
              getEffectiveDailyLimits(state, options, todayStr);

            const isSessionDisabled = sessionId ? state.disabledSessions[sessionId] === true : false;
            const sessionCostCap = sessionId ? state.sessionCostLimits[sessionId]?.limit : undefined;
            const sessionTokenCap = sessionId ? state.sessionTokenLimits[sessionId]?.limit : undefined;
            const sessionMetrics = sessionId ? getSessionMetrics(sessionId) : null;

            let result = `=== OpenCode Budget Allowance Status (${todayStr}) ===\n`;
            result += `📊 Today's Total Spend (All Sessions):\n`;
            result += `• Total Cost Spent: $${metrics.dailyCost.toFixed(2)}\n`;
            result += `• Total Tokens Used: ${metrics.dailyTokens.toLocaleString()}\n`;
            result += `• Active Sessions Today: ${metrics.sessionCount}\n`;
            result += `• Average Cost / Session: $${metrics.avgCost.toFixed(2)}\n\n`;

            result += `⚙️ Global / Daily Allowance Status:\n`;
            if (state.globalDisabled === true) {
              result += `• Budget Checks: GLOBALLY DISABLED (no limits enforced anywhere)\n`;
            } else {
              result += `• Budget Checks: Active (limits enforced)\n`;
              if (effectiveDailyCostLimit !== Infinity) {
                const dailyRemaining = Math.max(0, effectiveDailyCostLimit - metrics.dailyCost);
                const dailyPct = effectiveDailyCostLimit > 0 ? ((metrics.dailyCost / effectiveDailyCostLimit) * 100).toFixed(1) : "0.0";
                result += `• Daily Cost Cap: $${effectiveDailyCostLimit.toFixed(2)} (Spent: $${metrics.dailyCost.toFixed(2)} | Remaining: $${dailyRemaining.toFixed(2)} | ${dailyPct}% used)\n`;
              } else {
                result += `• Daily Cost Cap: Unlimited (no daily limit set)\n`;
              }

              if (effectiveDailyTokenLimit !== Infinity) {
                const dailyTokensRemaining = Math.max(0, effectiveDailyTokenLimit - metrics.dailyTokens);
                const dailyTokenPct = effectiveDailyTokenLimit > 0 ? ((metrics.dailyTokens / effectiveDailyTokenLimit) * 100).toFixed(1) : "0.0";
                result += `• Daily Token Cap: ${formatK(effectiveDailyTokenLimit)} (Used: ${formatK(metrics.dailyTokens)} | Remaining: ${formatK(dailyTokensRemaining)} | ${dailyTokenPct}% used)\n`;
              } else {
                result += `• Daily Token Cap: Unlimited (no token ceiling set)\n`;
              }

              if (dailyTopUpUSD > 0 || dailyTopUpTokens > 0) {
                const topUps: string[] = [];
                if (dailyTopUpUSD > 0) topUps.push(`+$${dailyTopUpUSD.toFixed(2)}`);
                if (dailyTopUpTokens > 0) topUps.push(`+${formatK(dailyTopUpTokens)} tokens`);
                result += `• Daily Top-Up Active Today: ${topUps.join(", ")}\n`;
              }
            }
            result += `\n`;

            if (sessionId && sessionMetrics) {
              const titleStr = sessionMetrics.title ? ` "${sessionMetrics.title}"` : "";
              result += `🎯 Current Session (${sessionId}${titleStr}):\n`;
              result += `• Session Cost Spent: $${sessionMetrics.cost.toFixed(2)}\n`;
              result += `• Session Tokens Used: ${sessionMetrics.totalTokens.toLocaleString()} (Input: ${sessionMetrics.tokensInput.toLocaleString()} | Output: ${sessionMetrics.tokensOutput.toLocaleString()})\n`;

              if (state.globalDisabled === true) {
                result += `• Status: Bypassed (Global Disable is active)\n`;
              } else if (isSessionDisabled) {
                result += `• Status: Budget checks DISABLED for this session\n`;
              } else {
                if (sessionCostCap !== undefined && sessionCostCap !== Infinity) {
                  const remCost = Math.max(0, sessionCostCap - sessionMetrics.cost);
                  const costPct = sessionCostCap > 0 ? ((sessionMetrics.cost / sessionCostCap) * 100).toFixed(1) : "0.0";
                  result += `• Session Cost Cap: $${sessionCostCap.toFixed(2)} (Spent: $${sessionMetrics.cost.toFixed(2)} | Remaining: $${remCost.toFixed(2)} | ${costPct}% used)\n`;
                } else {
                  result += `• Session Cost Cap: None (unlimited)\n`;
                }

                if (sessionTokenCap !== undefined && sessionTokenCap !== Infinity) {
                  const remTok = Math.max(0, sessionTokenCap - sessionMetrics.totalTokens);
                  const tokPct = sessionTokenCap > 0 ? ((sessionMetrics.totalTokens / sessionTokenCap) * 100).toFixed(1) : "0.0";
                  result += `• Session Token Cap: ${formatK(sessionTokenCap)} (Used: ${formatK(sessionMetrics.totalTokens)} | Remaining: ${formatK(remTok)} | ${tokPct}% used)\n`;
                } else {
                  result += `• Session Token Cap: None (unlimited)\n`;
                }
              }
            }

            return result;
          },
        }),

        budget_set_limit: tool({
          description: "Set or top-up a cost ($) or token budget limit for the current session or daily allowance. Reports previous limit, spend, and remaining balance.",
          args: {
            amount: tool.schema.number().describe("The budget limit amount (e.g. 20 for $20, or 500000 for 500k tokens)"),
            type: tool.schema.enum(["cost", "token"]).default("cost").describe("Whether this limit is cost (USD) or token count"),
            scope: tool.schema.enum(["session", "daily"]).default("session").describe("Whether to apply to active session or today's daily limit"),
            mode: tool.schema.enum(["set", "topup"]).default("set").describe("'set' sets the total target limit (replaces/defines cap); 'topup' adds onto the existing limit/topup"),
          },
          async execute(args, context) {
            const state = loadState();
            const todayStr = new Date().toISOString().split("T")[0];
            const sessionId = context?.sessionID || process.env.OPENCODE_SESSION_ID || "ACTIVE_SESSION";
            const metrics = getOverviewMetrics();
            const sessionMetrics = sessionId ? getSessionMetrics(sessionId) : null;

            if (args.scope === "daily") {
              const { baseDailyCost, baseDailyTokens } = getEffectiveDailyLimits(state, options, todayStr);
              if (args.type === "cost") {
                const prevTopUp = state.dailyTopUpUSD[todayStr] || 0;
                let newTopUp = 0;
                let newEffective = 0;
                if (args.mode === "topup") {
                  newTopUp = prevTopUp + args.amount;
                  newEffective = (baseDailyCost > 0 ? baseDailyCost : 0) + newTopUp;
                } else {
                  newEffective = args.amount;
                  newTopUp = Math.max(0, args.amount - baseDailyCost);
                }
                state.dailyTopUpUSD[todayStr] = newTopUp;
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

                const remaining = Math.max(0, newEffective - metrics.dailyCost);
                const pct = newEffective > 0 ? ((metrics.dailyCost / newEffective) * 100).toFixed(1) : "0.0";
                return (
                  `✅ ${args.mode === "topup" ? "Topped up" : "Set"} daily cost budget cap to $${newEffective.toFixed(2)} for today (${todayStr}).\n` +
                  `• Spent today so far: $${metrics.dailyCost.toFixed(2)} across ${metrics.sessionCount} sessions\n` +
                  `• Remaining / Pending daily allowance: $${remaining.toFixed(2)} (${pct}% used)`
                );
              } else {
                const prevTopUp = state.dailyTopUpTokens[todayStr] || 0;
                let newTopUp = 0;
                let newEffective = 0;
                if (args.mode === "topup") {
                  newTopUp = prevTopUp + args.amount;
                  newEffective = (baseDailyTokens > 0 ? baseDailyTokens : 0) + newTopUp;
                } else {
                  newEffective = args.amount;
                  newTopUp = Math.max(0, args.amount - baseDailyTokens);
                }
                state.dailyTopUpTokens[todayStr] = newTopUp;
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

                const remaining = Math.max(0, newEffective - metrics.dailyTokens);
                const pct = newEffective > 0 ? ((metrics.dailyTokens / newEffective) * 100).toFixed(1) : "0.0";
                return (
                  `✅ ${args.mode === "topup" ? "Topped up" : "Set"} daily token budget cap to ${formatK(newEffective)} tokens for today (${todayStr}).\n` +
                  `• Tokens used today: ${metrics.dailyTokens.toLocaleString()}\n` +
                  `• Remaining / Pending daily tokens: ${formatK(remaining)} (${pct}% used)`
                );
              }
            } else {
              delete state.disabledSessions[sessionId];
              const sessionCostSpent = sessionMetrics?.cost ?? 0;
              const sessionTokensSpent = sessionMetrics?.totalTokens ?? 0;

              if (args.type === "cost") {
                const currentLimit = state.sessionCostLimits[sessionId]?.limit;
                const newLimit = args.mode === "topup" && currentLimit !== undefined ? currentLimit + args.amount : args.amount;
                state.sessionCostLimits[sessionId] = { limit: newLimit, model: "AI_TOOL" };
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

                const remaining = Math.max(0, newLimit - sessionCostSpent);
                const pct = newLimit > 0 ? ((sessionCostSpent / newLimit) * 100).toFixed(1) : "0.0";
                return (
                  `✅ ${args.mode === "topup" ? "Increased" : "Set"} session cost budget cap to $${newLimit.toFixed(2)} for session ${sessionId}.\n` +
                  `• Spent so far in this session: $${sessionCostSpent.toFixed(2)}\n` +
                  `• Remaining / Pending session allowance: $${remaining.toFixed(2)} (${pct}% used)`
                );
              } else {
                const currentLimit = state.sessionTokenLimits[sessionId]?.limit;
                const newLimit = args.mode === "topup" && currentLimit !== undefined ? currentLimit + args.amount : args.amount;
                state.sessionTokenLimits[sessionId] = { limit: newLimit, model: "AI_TOOL" };
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

                const remaining = Math.max(0, newLimit - sessionTokensSpent);
                const pct = newLimit > 0 ? ((sessionTokensSpent / newLimit) * 100).toFixed(1) : "0.0";
                return (
                  `✅ ${args.mode === "topup" ? "Increased" : "Set"} session token budget cap to ${formatK(newLimit)} tokens for session ${sessionId}.\n` +
                  `• Tokens used in this session: ${sessionTokensSpent.toLocaleString()}\n` +
                  `• Remaining / Pending session tokens: ${formatK(remaining)} (${pct}% used)`
                );
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

        // Auto-compaction if input tokens exceed threshold
        if (compactAtInputTokens !== Infinity) {
          const sessionRow = queryDb(
            (db) => db.query(`SELECT tokens_input FROM session WHERE id = ?`).get(sessionId) as { tokens_input: number } | null,
            null
          );
          if (sessionRow && sessionRow.tokens_input >= compactAtInputTokens) {
            try {
              if (client?.session?.compact) {
                await client.session.compact({ path: { id: sessionId } });
              }
            } catch {
              // Silent fallback
            }
          }
        }
      },
    };
  }) satisfies Plugin,
} satisfies PluginModule;
