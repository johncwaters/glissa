"use strict";

const { buildHookCommand } = require("./hook-command-core");

/** @param {string} command */
function hookGroup(command) {
  return [{ hooks: [{ type: "command", command }] }];
}

/** @param {{ relayPath: string, events: string[] }} options */
function renderGrokHooksFile({ relayPath, events }) {
  /** @type {Record<string, Array<{ hooks: Array<{ type: string, command: string }> }>>} */
  const hooks = {};
  for (const event of events) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    hooks[event] = hookGroup(command);
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

/** @param {unknown} value @param {string[]} expectedKeys @returns {value is Record<string, unknown>} */
function hasOnlyKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

/** @param {unknown} command @param {string} event */
function isManagedCommand(command, event) {
  if (typeof command !== "string") return false;
  const match = command.match(/^node (?:(?:"([^"\r\n]+)")|([^\s"']+)) ([A-Za-z][A-Za-z0-9_-]{0,63})$/);
  if (!match) return false;
  const relayPath = match[1] || match[2];
  if (match[3] !== event) return false;
  if (!/(?:^|\/)hook-relay\.js$/.test(relayPath)) return false;
  return buildHookCommand(relayPath, event) === command;
}

/** @param {unknown} group @param {string} event */
function isManagedHookGroup(group, event) {
  if (!Array.isArray(group) || group.length !== 1) return false;
  const matcherGroup = group[0];
  if (!hasOnlyKeys(matcherGroup, ["hooks"])) return false;
  if (!Array.isArray(matcherGroup.hooks) || matcherGroup.hooks.length !== 1) return false;
  const handler = matcherGroup.hooks[0];
  if (!hasOnlyKeys(handler, ["type", "command"])) return false;
  if (handler.type !== "command") return false;
  return isManagedCommand(handler.command, event);
}

/**
 * @param {string|null|undefined} contents
 * @param {{ relayPath: string, events: string[], managedEventSets?: string[][] }} options
 */
function classifyGrokHooksFile(contents, { relayPath, events, managedEventSets = [] }) {
  if (contents == null) return "absent";
  const expected = renderGrokHooksFile({ relayPath, events });
  if (contents === expected) return "current";
  /** @type {unknown} */
  let parsed = null;
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

module.exports = {
  renderGrokHooksFile,
  classifyGrokHooksFile,
  isManagedCommand,
};
