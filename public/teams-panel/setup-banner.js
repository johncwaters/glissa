// Show or hide the "fill the pack" banner for an instance. Driven by get-team-pack-status so the
// operator sees the setup callout BEFORE running, not only after a halted run.

import { sendControlMsg } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { setCollapsed, setStatus } from './run-status.js';

export function renderSetup(refs, ps) {
  if (!refs.setupEl) return;
  if (!ps || ps.configured) { refs.setupEl.hidden = true; refs.setupEl.replaceChildren(); return; }
  refs.setupEl.hidden = false;
  setCollapsed(refs, false); // an unfilled pack is a blocker; never hide it behind the collapsed state
  const head = el('p', 'team-setup-head', 'Set up this project’s pack before the first run.');
  const sub = el('p', 'team-setup-sub', 'Agents read this project’s voice, brand, and channels from it on every run.');

  // A guided interview agent reads the target repo, interviews the operator for the subjective bits, and
  // writes the pack for you. It opens as its own terminal session card you answer in.
  const auto = el('button', 'team-setup-auto', 'Set up automatically');
  auto.type = 'button';
  auto.addEventListener('click', () => {
    auto.disabled = true;
    setStatus(refs, 'Starting setup...', 'run');
    sendControlMsg({ type: 'setup-team-pack', teamId: refs.teamId, projectId: refs.projectId });
  });

  refs.setupEl.replaceChildren(head, sub, auto);
}
