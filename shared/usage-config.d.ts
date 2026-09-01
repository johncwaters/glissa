export declare const USAGE_COST_MODES: readonly ["auto", "calculate", "display"];
export declare const USAGE_VENDOR_KEYS: readonly ["codex", "grok"];
export declare const USAGE_BUDGET_KEYS: readonly ["dailyUsd", "monthlyUsd"];
export type UsageCostMode = (typeof USAGE_COST_MODES)[number];
export type UsageVendorKey = (typeof USAGE_VENDOR_KEYS)[number];
export type UsageBudgetKey = (typeof USAGE_BUDGET_KEYS)[number];
