// ── Add-team bar ──────────────────────────────────────────────

import { sendControlMsg } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { key } from './format-core.mjs';
import { mounted } from './registry.js';

export function buildAddBar() {
  const bar = el('div', 'teams-add');
  const toggle = el('button', 'teams-add-toggle', '+ Add team');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');

  const form = el('div', 'teams-add-form');
  form.hidden = true;
  const rosterField = el('label', 'teams-add-field');
  rosterField.append(el('span', 'teams-add-label', 'Roster'));
  const rosterSel = el('select', 'teams-add-roster');
  rosterField.append(rosterSel);
  const projField = el('label', 'teams-add-field');
  projField.append(el('span', 'teams-add-label', 'Target project'));
  const projSel = el('select', 'teams-add-project');
  projField.append(projSel);
  const addBtn = el('button', 'teams-add-confirm', 'Add');
  addBtn.type = 'button';
  const cancelBtn = el('button', 'teams-add-cancel', 'Cancel');
  cancelBtn.type = 'button';
  const err = el('span', 'teams-add-err');
  form.append(rosterField, projField, addBtn, cancelBtn, err);

  bar.append(toggle, form);
  return { bar, toggle, form, rosterSel, projSel, addBtn, cancelBtn, err };
}

export function populateRosterOptions(sel) {
  sel.replaceChildren();
  const def = el('option', null, 'Select a roster');
  def.value = ''; def.disabled = true; def.selected = true;
  sel.append(def);
  for (const t of mounted.teams.values()) {
    const o = el('option', null, t.name || t.id);
    o.value = t.id;
    sel.append(o);
  }
}

export function populateProjectOptions(sel) {
  sel.replaceChildren();
  const projects = mounted.projects || [];
  if (!projects.length) {
    const o = el('option', null, 'Add a session first');
    o.value = ''; o.disabled = true; o.selected = true;
    sel.append(o);
    sel.disabled = true;
    if (mounted.addBar) mounted.addBar.addBtn.disabled = true;
    return;
  }
  // Symmetric with the empty branch above: re-enable in case a prior call disabled the picker when
  // there were no projects yet (e.g. an in-place refresh after the snapshot fills the project list).
  sel.disabled = false;
  if (mounted.addBar) mounted.addBar.addBtn.disabled = false;
  const def = el('option', null, 'Select a project');
  def.value = ''; def.disabled = true; def.selected = true;
  sel.append(def);
  for (const p of projects) {
    const o = el('option', null, p.name);
    o.value = p.id;
    sel.append(o);
  }
}

// Repopulate ONLY the add-bar project picker in place (no view teardown), preserving any in-progress
// selection. Called from app.js handleSnapshot when Teams was restored as the active view at boot: its
// picker was seeded empty before knownProjects existed. A full mountTeamsView would wipe a mid-edit
// add-form, reset instance timers, and re-fire list-teams (a non-restart WS reconnect re-runs
// handleSnapshot with no page reload), so refresh the <select> in place instead.
export function refreshTeamsProjects(projects) {
  if (!mounted || !mounted.addBar) return;
  const prev = mounted.addBar.projSel.value;
  mounted.projects = projects || [];
  populateProjectOptions(mounted.addBar.projSel);
  if (prev && [...mounted.addBar.projSel.options].some((o) => o.value === prev)) {
    mounted.addBar.projSel.value = prev;
  }
}

export function wireAddBar(add) {
  add.toggle.addEventListener('click', () => {
    const open = add.form.hidden;
    add.form.hidden = !open;
    add.toggle.setAttribute('aria-expanded', String(open));
    add.err.textContent = '';
    if (open) requestAnimationFrame(() => add.rosterSel.focus());
  });
  add.cancelBtn.addEventListener('click', () => {
    add.form.hidden = true;
    add.toggle.setAttribute('aria-expanded', 'false');
  });
  add.addBtn.addEventListener('click', () => {
    add.err.textContent = '';
    const teamId = add.rosterSel.value;
    const projectId = add.projSel.value;
    if (!teamId || !projectId) { add.err.textContent = 'Pick a roster and a project.'; return; }
    if (mounted.instances.has(key(teamId, projectId))) { add.err.textContent = 'That team already targets that project.'; return; }
    sendControlMsg({ type: 'add-team-instance', teamId, projectId });
  });
}
