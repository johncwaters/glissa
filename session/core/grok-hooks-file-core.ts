import { buildHookCommand } from "./hook-command-core.ts";

interface HookHandler {
  type: string;
  command: string;
}

interface HookMatcherGroup {
  hooks: HookHandler[];
}

type GrokHooksClassification = "absent" | "current" | "foreign" | "managed-stale";

interface GrokHooksFileOptions {
  relayPath: string;
  events: string[];
  managedEventSets?: string[][];
}

function hookGroup(command: string): HookMatcherGroup[] {
  return [{ hooks: [{ type: "command", command }] }];
}

function renderGrokHooksFile({ relayPath, events }: { relayPath: string; events: string[] }): string | null {
  const hooks: Record<string, HookMatcherGroup[]> = {};
  for (const event of events) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    hooks[event] = hookGroup(command);
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

function hasOnlyKeys(value: unknown, expectedKeys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

const MANAGED_RELAY_RE = /(?:^|\/)hook-relay\.(?:js|ts)$/;

function isManagedCommand(command: unknown, event: string): boolean {
  if (typeof command !== "string") return false;
  const match = command.match(/^node (?:(?:"([^"\r\n]+)")|([^\s"']+)) ([A-Za-z][A-Za-z0-9_-]{0,63})$/);
  if (!match) return false;
  const relayPath = match[1] || match[2];
  if (match[3] !== event) return false;
  if (!MANAGED_RELAY_RE.test(relayPath)) return false;
  return buildHookCommand(relayPath, event) === command;
}

function isManagedHookGroup(group: unknown, event: string): boolean {
  if (!Array.isArray(group) || group.length !== 1) return false;
  const matcherGroup: unknown = group[0];
  if (!hasOnlyKeys(matcherGroup, ["hooks"])) return false;
  if (!Array.isArray(matcherGroup.hooks) || matcherGroup.hooks.length !== 1) return false;
  const handler: unknown = matcherGroup.hooks[0];
  if (!hasOnlyKeys(handler, ["type", "command"])) return false;
  if (handler.type !== "command") return false;
  return isManagedCommand(handler.command, event);
}

function classifyGrokHooksFile(
  contents: string | null | undefined,
  { relayPath, events, managedEventSets = [] }: GrokHooksFileOptions,
): GrokHooksClassification {
  if (contents == null) return "absent";
  const expected = renderGrokHooksFile({ relayPath, events });
  if (contents === expected) return "current";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return "foreign";
  }
  if (!hasOnlyKeys(parsed, ["hooks"])) return "foreign";
  const hooksValue = parsed.hooks;
  if (hooksValue === null || hooksValue === undefined) throw new TypeError("hooks must be an object");
  if (typeof hooksValue !== "object" || Array.isArray(hooksValue)) return "foreign";
  const actualEvents = Object.keys(hooksValue);
  if (!hasOnlyKeys(hooksValue, actualEvents)) return "foreign";
  const hooks = hooksValue;
  const hasManagedEventSet = hasOnlyKeys(hooks, events)
    || managedEventSets.some((managedEvents) => hasOnlyKeys(hooks, managedEvents));
  if (!hasManagedEventSet) return "foreign";
  for (const event of actualEvents) {
    if (!isManagedHookGroup(hooks[event], event)) return "foreign";
  }
  return "managed-stale";
}

export { renderGrokHooksFile, classifyGrokHooksFile, isManagedCommand };
export type { GrokHooksClassification, GrokHooksFileOptions, HookHandler, HookMatcherGroup };
