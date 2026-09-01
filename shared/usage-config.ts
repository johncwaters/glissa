export const USAGE_COST_MODES = Object.freeze(['auto', 'calculate', 'display'] as const);
export const USAGE_VENDOR_KEYS = Object.freeze(['codex', 'grok'] as const);
export const USAGE_BUDGET_KEYS = Object.freeze(['dailyUsd', 'monthlyUsd'] as const);

export type UsageCostMode = (typeof USAGE_COST_MODES)[number];
export type UsageVendorKey = (typeof USAGE_VENDOR_KEYS)[number];
export type UsageBudgetKey = (typeof USAGE_BUDGET_KEYS)[number];
