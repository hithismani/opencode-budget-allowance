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

export function localDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function loadPluginOptions(): BudgetOptions {
  const paths = [
    path.join(os.homedir(), ".config/opencode/opencode.json"),
    path.join(os.homedir(), ".config/opencode/opencode.jsonc"),
  ];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const content = JSON.parse(fs.readFileSync(p, "utf-8"));
      for (const entry of content?.plugin || []) {
        const pluginPath = Array.isArray(entry) ? entry[0] : entry;
        if (typeof pluginPath === "string" && pluginPath.endsWith("budget.ts")) {
          return Array.isArray(entry) && entry[1] && typeof entry[1] === "object" ? entry[1] : {};
        }
      }
    } catch {
      // jsonc / unreadable — skip
    }
  }
  return {};
}

export function formatHistory(state: BudgetState, n = 10): string {
  if (state.history.length === 0) return "  (No top-up records found)";
  return state.history
    .slice(-n)
    .reverse()
    .map((rec) => {
      const date = new Date(rec.timestamp).toLocaleString();
      const amtStr =
        rec.type === "cost" ? `$${rec.amount.toFixed(2)}` : rec.type === "token" ? formatK(rec.amount) : rec.type;
      return `  • [${date}] Scope: ${rec.scope} | Type: ${rec.type} | Amount: ${amtStr} | Session: ${rec.sessionId}`;
    })
    .join("\n");
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

export function formatCap(type: "cost" | "token", amount: number): string {
  return type === "cost" ? `$${amount.toFixed(2)}` : `${formatK(amount)} tokens`;
}

function clearSibling(state: BudgetState, scope: "daily" | "session", type: "cost" | "token", id: string): string | null {
  if (scope === "daily") {
    const other = type === "cost" ? "dailyTopUpTokens" : "dailyTopUpUSD";
    const prev = state[other][id];
    if (!prev) return null;
    delete state[other][id];
    return type === "cost"
      ? `Cleared daily token cap (${formatK(prev)}) — daily is cost-only.`
      : `Cleared daily cost cap ($${prev.toFixed(2)}) — daily is token-only.`;
  }
  if (type === "cost" && state.sessionTokenLimits[id]) {
    const prev = state.sessionTokenLimits[id].limit;
    delete state.sessionTokenLimits[id];
    return `Cleared session token cap (${formatK(prev)}) — this session is cost-only.`;
  }
  if (type === "token" && state.sessionCostLimits[id]) {
    const prev = state.sessionCostLimits[id].limit;
    delete state.sessionCostLimits[id];
    return `Cleared session cost cap ($${prev.toFixed(2)}) — this session is token-only.`;
  }
  return null;
}

export function applyDailyLimit(
  state: BudgetState,
  options: BudgetOptions,
  dateStr: string,
  type: "cost" | "token",
  amount: number,
  mode: "set" | "topup"
): { newEffective: number; newTopUp: number; cleared: string | null } {
  const { baseDailyCost, baseDailyTokens } = getEffectiveDailyLimits(state, options, dateStr);
  const base = type === "cost" ? baseDailyCost : baseDailyTokens;
  const key = type === "cost" ? "dailyTopUpUSD" : "dailyTopUpTokens";
  const prevTopUp = state[key][dateStr] || 0;
  const newTopUp = mode === "topup" ? prevTopUp + amount : amount - base;
  const newEffective = base + newTopUp;
  state[key][dateStr] = newTopUp;
  const cleared = clearSibling(state, "daily", type, dateStr);
  return { newEffective, newTopUp, cleared };
}

export function applySessionLimit(
  state: BudgetState,
  sessionId: string,
  type: "cost" | "token",
  amount: number,
  mode: "set" | "topup",
  model = "AI_TOOL"
): { newLimit: number; cleared: string | null } {
  const map = type === "cost" ? state.sessionCostLimits : state.sessionTokenLimits;
  const current = map[sessionId]?.limit;
  const newLimit = mode === "topup" && current !== undefined ? current + amount : amount;
  map[sessionId] = { limit: newLimit, model };
  const cleared = clearSibling(state, "session", type, sessionId);
  return { newLimit, cleared };
}

export function crossScopeNote(
  state: BudgetState,
  options: BudgetOptions,
  todayStr: string,
  sessionId: string,
  justSet: { scope: "daily" | "session"; type: "cost" | "token"; amount: number }
): string | null {
  const daily = getEffectiveDailyLimits(state, options, todayStr);
  const dailyType: "cost" | "token" | null =
    daily.effectiveDailyCostLimit !== Infinity ? "cost" : daily.effectiveDailyTokenLimit !== Infinity ? "token" : null;
  const dailyAmt =
    dailyType === "cost" ? daily.effectiveDailyCostLimit : dailyType === "token" ? daily.effectiveDailyTokenLimit : null;
  const sessionType: "cost" | "token" | null = state.sessionCostLimits[sessionId]
    ? "cost"
    : state.sessionTokenLimits[sessionId]
      ? "token"
      : null;
  const sessionAmt =
    sessionType === "cost"
      ? state.sessionCostLimits[sessionId].limit
      : sessionType === "token"
        ? state.sessionTokenLimits[sessionId].limit
        : null;
  if (!dailyType || dailyAmt == null || !sessionType || sessionAmt == null) return null;
  if (justSet.scope === "session") {
    return `Btw daily was ${formatCap(dailyType, dailyAmt)} — ignored for this session. This session uses ${formatCap(sessionType, sessionAmt)}.`;
  }
  return `Btw this session still has ${formatCap(sessionType, sessionAmt)} — that session override ignores this daily ${formatCap(dailyType, dailyAmt)}.`;
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

  const todayStr = localDateStr();
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

  const sessionCostOverride = sessionId ? state.sessionCostLimits[sessionId]?.limit : undefined;
  const sessionTokenOverride = sessionId ? state.sessionTokenLimits[sessionId]?.limit : undefined;
  const hasSessionOverride = sessionCostOverride !== undefined || sessionTokenOverride !== undefined;

  const providerNestedCost = providerId && providerModelCostBudgets[providerId]
    ? findMatchingLimit(providerModelCostBudgets[providerId], [modelId, fullModelKey])
    : undefined;

  const baseSessionCostCap = hasSessionOverride
    ? (sessionCostOverride ?? Infinity)
    : providerNestedCost ??
      findMatchingLimit(modelCostBudgets, [fullModelKey, modelId]) ??
      findMatchingLimit(providerCostBudgets, [providerId]) ??
      defaultSessionLimitUSD;

  const providerNestedToken = providerId && providerModelTokenBudgets[providerId]
    ? findMatchingLimit(providerModelTokenBudgets[providerId], [modelId, fullModelKey])
    : undefined;

  const baseSessionTokenCap = hasSessionOverride
    ? (sessionTokenOverride ?? Infinity)
    : providerNestedToken ??
      findMatchingLimit(modelTokenBudgets, [fullModelKey, modelId]) ??
      findMatchingLimit(providerTokenBudgets, [providerId]) ??
      defaultSessionTokenLimit;

  const daily = getEffectiveDailyLimits(state, options, todayStr);
  const effectiveDailyCostLimit = hasSessionOverride ? Infinity : daily.effectiveDailyCostLimit;
  const effectiveDailyTokenLimit = hasSessionOverride ? Infinity : daily.effectiveDailyTokenLimit;

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

export function isBudgetTalk(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("/budget") ||
    t.includes("budget") ||
    t.includes("allowance") ||
    t.includes("allocate") ||
    t.includes("override") ||
    t.includes("disable budget") ||
    t.includes("turn off budget") ||
    t.includes("off global")
  );
}

export function budgetStopText(reason: string): string {
  return (
    `[Budget Limit Reached] ${reason}\n` +
    `How to proceed: /budget daily +<amount>  |  /budget off  |  /budget off global\n` +
    `Or: bun run ~/.config/opencode/plugins/cli.ts`
  );
}

async function surfaceBudgetStop(client: any, sessionId: string, reason: string): Promise<void> {
  const message = budgetStopText(reason);
  try {
    await client?.tui?.showToast?.({
      body: { title: "Budget Limit Reached", message, variant: "error", duration: 20000 },
    });
  } catch {
    // TUI toast is best-effort
  }
  if (sessionId) {
    try {
      await client?.session?.abort?.({ path: { id: sessionId } });
    } catch {
      // abort is best-effort — toast + transcript still cite the cap
    }
  }
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
    const sessionModels = new Map<string, ReturnType<typeof resolveModelAndProvider>>();

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
          .join(" ");

        const managing = isBudgetTalk(text);
        if (sessionId) {
          if (managing) managingSessions.add(sessionId);
          else managingSessions.delete(sessionId);
        }
        if (managing) return;

        const resolved = resolveModelAndProvider(input?.model, undefined);
        if (sessionId) sessionModels.set(sessionId, resolved);
        const { hardStopReason } = checkBudgetStatus(
          sessionId,
          resolved.displayName,
          resolved.providerId,
          resolved.modelId,
          resolved.fullModelKey,
          options
        );
        if (hardStopReason) {
          const notice = budgetStopText(hardStopReason);
          output.parts = output.parts || [];
          output.parts.push({ type: "text", text: `\n\n${notice}` });
          await surfaceBudgetStop(client, sessionId, hardStopReason);
        }
      },

      "experimental.chat.system.transform": async (input: any, output: any) => {
        const sessionId = input?.sessionID || "";
        const state = loadState();
        const isSessionDisabled = sessionId ? state.disabledSessions[sessionId] === true : false;
        const todayStr = localDateStr();
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

        const resolved = resolveModelAndProvider(input?.model, undefined);
        const { providerId, modelId, fullModelKey, displayName } = resolved;
        if (sessionId) sessionModels.set(sessionId, resolved);

        const { hardStopReason, warningReason } = checkBudgetStatus(
          sessionId,
          displayName,
          providerId,
          modelId,
          fullModelKey,
          options
        );

        const managing = sessionId ? managingSessions.has(sessionId) : false;
        if (hardStopReason && !managing) {
          output.system.push(
            `🛑 [BUDGET LIMIT EXCEEDED: 100% HARD STOP - ${hardStopReason}]\n` +
            `Your ENTIRE reply must be only this, even if the user said hi or asked a question:\n` +
            `1. Cite that they have reached 100% of their budget (${hardStopReason}).\n` +
            `2. Ask how they want to proceed. Do not continue until they choose:\n` +
            `   • /budget daily <amount> or /budget daily +<amount> — raise today's cap\n` +
            `   • /budget off — disable checks for this session\n` +
            `   • /budget off global — disable checks everywhere\n` +
            `   • bun run ~/.config/opencode/plugins/cli.ts — offline menu\n` +
            `Do NOT greet. Do NOT answer their question. Do NOT write code or use tools.`
          );
        } else if (warningReason && !managing) {
          output.system.push(
            `⚠️ [BUDGET WARNING: 90% THRESHOLD REACHED - ${warningReason}]\n` +
            `Cite ${warningReason} to the user. Do not continue the task until they say how to proceed:\n` +
            `  1. Continue until the 100% hard stop\n` +
            `  2. /budget daily +<amount> or /budget <amount> to raise the cap\n` +
            `  3. /budget off to disable this session`
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
        if (sessionId && managingSessions.has(sessionId)) return;
        const state = loadState();
        if (state.globalDisabled === true) return;
        if (sessionId && state.disabledSessions[sessionId] === true) return;

        const resolved = (sessionId && sessionModels.get(sessionId)) || resolveModelAndProvider(input?.model, input?.provider);
        const { hardStopReason } = checkBudgetStatus(
          sessionId,
          resolved.displayName,
          resolved.providerId,
          resolved.modelId,
          resolved.fullModelKey,
          options
        );

        if (hardStopReason) {
          throw new Error(budgetStopText(hardStopReason));
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
            const todayStr = localDateStr();
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
          description: "Set or top-up a budget. Bare numbers are USD (type=cost). Use type=token only when the user said k/m/b or an explicit token count (e.g. 500k).",
          args: {
            amount: tool.schema.number().describe("USD if type=cost (default). Raw token count if type=token (e.g. 500000 for 500k)."),
            type: tool.schema.enum(["cost", "token"]).default("cost").describe("cost = dollars (default for 15, 40, $40). token = only for 500k / 2m / explicit tokens."),
            scope: tool.schema.enum(["session", "daily"]).default("session").describe("Whether to apply to active session or today's daily limit"),
            mode: tool.schema.enum(["set", "topup"]).default("set").describe("'set' sets the total target limit (replaces/defines cap); 'topup' adds onto the existing limit/topup"),
          },
          async execute(args, context) {
            const limitType = args.type === "token" ? "token" : "cost";
            const mode = args.mode === "topup" ? "topup" : "set";
            if (limitType === "token" && args.amount > 0 && args.amount < 1000) {
              return `⚠️ ${args.amount} tokens is not a real cap. Bare numbers are USD — re-call with type="cost" for $${args.amount.toFixed(2)}, or type="token" with 1000+ (e.g. 500000 for 500k).`;
            }

            const state = loadState();
            const todayStr = localDateStr();
            const sessionId = context?.sessionID || process.env.OPENCODE_SESSION_ID || "ACTIVE_SESSION";
            const metrics = getOverviewMetrics();
            const sessionMetrics = sessionId ? getSessionMetrics(sessionId) : null;

            const extras: string[] = [];
            if (args.scope === "daily") {
              const { newEffective, cleared } = applyDailyLimit(state, options, todayStr, limitType, args.amount, mode);
              if (cleared) extras.push(cleared);
              const note = crossScopeNote(state, options, todayStr, sessionId, { scope: "daily", type: limitType, amount: newEffective });
              if (note) extras.push(note);
              state.history.push({
                id: `tool_${Date.now()}`,
                timestamp: Date.now(),
                dateStr: todayStr,
                sessionId: "GLOBAL_DAILY",
                model: "AI_TOOL",
                scope: "daily",
                type: limitType,
                amount: args.amount,
              });
              saveState(state);

              const tail = extras.length ? `\n${extras.join("\n")}` : "";
              if (limitType === "cost") {
                const remaining = Math.max(0, newEffective - metrics.dailyCost);
                const pct = newEffective > 0 ? ((metrics.dailyCost / newEffective) * 100).toFixed(1) : "0.0";
                return (
                  `✅ ${mode === "topup" ? "Topped up" : "Set"} daily cost budget cap to $${newEffective.toFixed(2)} for today (${todayStr}).\n` +
                  `• Spent today so far: $${metrics.dailyCost.toFixed(2)} across ${metrics.sessionCount} sessions\n` +
                  `• Remaining / Pending daily allowance: $${remaining.toFixed(2)} (${pct}% used)` +
                  tail
                );
              } else {
                const remaining = Math.max(0, newEffective - metrics.dailyTokens);
                const pct = newEffective > 0 ? ((metrics.dailyTokens / newEffective) * 100).toFixed(1) : "0.0";
                return (
                  `✅ ${mode === "topup" ? "Topped up" : "Set"} daily token budget cap to ${formatK(newEffective)} tokens for today (${todayStr}).\n` +
                  `• Tokens used today: ${metrics.dailyTokens.toLocaleString()}\n` +
                  `• Remaining / Pending daily tokens: ${formatK(remaining)} (${pct}% used)` +
                  tail
                );
              }
            } else {
              delete state.disabledSessions[sessionId];
              const sessionCostSpent = sessionMetrics?.cost ?? 0;
              const sessionTokensSpent = sessionMetrics?.totalTokens ?? 0;
              const { newLimit, cleared } = applySessionLimit(state, sessionId, limitType, args.amount, mode);
              if (cleared) extras.push(cleared);
              const note = crossScopeNote(state, options, todayStr, sessionId, { scope: "session", type: limitType, amount: newLimit });
              if (note) extras.push(note);
              state.history.push({
                id: `tool_${Date.now()}`,
                timestamp: Date.now(),
                dateStr: todayStr,
                sessionId,
                model: "AI_TOOL",
                scope: "session",
                type: limitType,
                amount: args.amount,
              });
              saveState(state);

              const tail = extras.length ? `\n${extras.join("\n")}` : "";
              if (limitType === "cost") {
                const remaining = Math.max(0, newLimit - sessionCostSpent);
                const pct = newLimit > 0 ? ((sessionCostSpent / newLimit) * 100).toFixed(1) : "0.0";
                return (
                  `✅ ${mode === "topup" ? "Increased" : "Set"} session cost budget cap to $${newLimit.toFixed(2)} for session ${sessionId}.\n` +
                  `• Spent so far in this session: $${sessionCostSpent.toFixed(2)}\n` +
                  `• Remaining / Pending session allowance: $${remaining.toFixed(2)} (${pct}% used)` +
                  tail
                );
              } else {
                const remaining = Math.max(0, newLimit - sessionTokensSpent);
                const pct = newLimit > 0 ? ((sessionTokensSpent / newLimit) * 100).toFixed(1) : "0.0";
                return (
                  `✅ ${mode === "topup" ? "Increased" : "Set"} session token budget cap to ${formatK(newLimit)} tokens for session ${sessionId}.\n` +
                  `• Tokens used in this session: ${sessionTokensSpent.toLocaleString()}\n` +
                  `• Remaining / Pending session tokens: ${formatK(remaining)} (${pct}% used)` +
                  tail
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
            const todayStr = localDateStr();
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
            const todayStr = localDateStr();
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

        budget_get_history: tool({
          description: "Show the audit log of past budget top-ups, cap changes, and enable/disable events.",
          args: {},
          async execute() {
            return `Top-Up Audit History Log:\n${formatHistory(loadState())}`;
          },
        }),
      },

      "chat.params": async (params: any) => {
        const sessionId = params.sessionID || (params as any).sessionId || "";
        const resolved = resolveModelAndProvider(params.model, params.provider);
        if (sessionId) sessionModels.set(sessionId, resolved);
        if (!(sessionId && managingSessions.has(sessionId))) {
          const { hardStopReason } = checkBudgetStatus(
            sessionId,
            resolved.displayName,
            resolved.providerId,
            resolved.modelId,
            resolved.fullModelKey,
            options
          );
          if (hardStopReason) {
            await surfaceBudgetStop(client, sessionId, hardStopReason);
            return;
          }
        }

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
