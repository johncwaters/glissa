"use strict";

const SAFE_PATH_RE = /^[A-Za-z0-9_.:/\\ -]+$/;
const SAFE_EVENT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function buildHookCommand(relayPath, event) {
  const rawPath = String(relayPath);
  const rawEvent = String(event);
  if (!SAFE_PATH_RE.test(rawPath)) return null;
  if (!SAFE_EVENT_RE.test(rawEvent)) return null;
  const forwardSlashedPath = rawPath.replace(/\\/g, "/");
  const quotedPath = /\s/.test(forwardSlashedPath) ? `"${forwardSlashedPath}"` : forwardSlashedPath;
  return `node ${quotedPath} ${rawEvent}`;
}

module.exports = { SAFE_PATH_RE, SAFE_EVENT_RE, buildHookCommand };
