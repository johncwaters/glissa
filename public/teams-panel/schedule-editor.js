// ── Schedule editor ───────────────────────────────────────────

import { el } from '../dom-helpers.js';
import { DAYS, TZ_PRESETS } from './format-core.mjs';

function ensureTzDatalist() {
  if (document.getElementById('tz-presets')) return;
  const dl = document.createElement('datalist');
  dl.id = 'tz-presets';
  for (const z of TZ_PRESETS) { const o = document.createElement('option'); o.value = z; dl.append(o); }
  document.body.append(dl);
}

export function buildScheduleEditor() {
  ensureTzDatalist();
  const wrap = el('div', 'team-sched-editor');
  wrap.hidden = true;

  const daysRow = el('div', 'sched-days');
  daysRow.setAttribute('role', 'group');
  daysRow.setAttribute('aria-label', 'Days to run');
  const dayBtns = new Map();
  for (const [tok, label] of DAYS) {
    const b = el('button', 'sched-day', label);
    b.type = 'button';
    b.dataset.day = tok;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    });
    daysRow.append(b);
    dayBtns.set(tok, b);
  }

  const fields = el('div', 'sched-fields');
  const timeField = el('label', 'sched-field');
  timeField.append(el('span', 'sched-field-label', 'Time'));
  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.className = 'sched-time';
  timeField.append(timeInput);
  const tzField = el('label', 'sched-field');
  tzField.append(el('span', 'sched-field-label', 'Time zone'));
  const tzInput = document.createElement('input');
  tzInput.type = 'text';
  tzInput.className = 'sched-tz';
  tzInput.setAttribute('list', 'tz-presets');
  tzInput.spellcheck = false;
  tzInput.autocomplete = 'off';
  tzField.append(tzInput);
  fields.append(timeField, tzField);

  const actions = el('div', 'sched-editor-actions');
  const saveBtn = el('button', 'sched-save', 'Save schedule');
  saveBtn.type = 'button';
  const cancelBtn = el('button', 'sched-cancel', 'Cancel');
  cancelBtn.type = 'button';
  const err = el('span', 'sched-err');
  actions.append(saveBtn, cancelBtn, err);

  wrap.append(daysRow, fields, actions);

  return {
    wrap, dayBtns, timeInput, tzInput, saveBtn, cancelBtn, err,
    getValues() {
      const days = [...dayBtns].filter(([, b]) => b.getAttribute('aria-pressed') === 'true').map(([t]) => t);
      return { days, time: timeInput.value, tz: tzInput.value.trim() };
    },
    setValues(sch) {
      const set = new Set(((sch?.days) || []).map((d) => String(d).toLowerCase().slice(0, 3)));
      for (const [tok, b] of dayBtns) b.setAttribute('aria-pressed', String(set.has(tok)));
      timeInput.value = (sch?.time) || '05:00';
      tzInput.value = (sch?.tz) || 'America/Denver';
      err.textContent = '';
    },
  };
}
