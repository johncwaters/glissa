// ── Dialogs module ────────────────────────────────────────────
// Owns Add Session and Settings dialog factory functions.

import { playAlertSound, SOUND_OPTIONS } from './alert-sound.js';
import addSessionHTML from './components/add-session-dialog.html?raw';
import settingsHTML from './components/settings-dialog.html?raw';
import { sendControlMsg, sendControlRequest } from './control-ws.js';
import { countSessionsByName, suggestSessionName } from './session-card/naming.js';
import { applyTheme, getThemeList } from './theme.js';
import { getSoundId, getThemeId, setSoundId, setThemeId } from './ui-prefs.js';

// ── Shared dialog ARIA + focus trap helpers ──────────────────

function getFocusable(dialog) {
  return [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')];
}

function attachFocusTrap(dialog) {
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = getFocusable(dialog);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

function applyDialogAria(dialog, titleId) {
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  attachFocusTrap(dialog);
}

// ── Add Session dialog ────────────────────────────────────────

export function createAddSessionDialog() {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog';

  dialog.innerHTML = addSessionHTML;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Ensure title id exists for aria-labelledby
  let titleEl = dialog.querySelector('#add-session-title');
  if (!titleEl) {
    titleEl = dialog.querySelector('h2, h3, [class*="title"]');
    if (titleEl && !titleEl.id) titleEl.id = 'add-session-title';
  }
  applyDialogAria(dialog, 'add-session-title');

  const pickerEl = dialog.querySelector('#add-session-picker');
  const advancedToggle = dialog.querySelector('#add-session-advanced-toggle');
  const advancedPanel = dialog.querySelector('#add-session-advanced');
  const nameInput = dialog.querySelector('#add-session-name');
  const pathInput = dialog.querySelector('#add-session-path');
  const skipPermsCheckbox = dialog.querySelector('#add-session-skip-perms');
  const errorEl = dialog.querySelector('#add-session-error');
  const btnCancel = dialog.querySelector('#add-session-cancel');
  const btnConfirm = dialog.querySelector('#add-session-confirm');

  // Advanced options toggle
  advancedToggle.setAttribute('aria-expanded', 'false');
  advancedToggle.addEventListener('click', () => {
    const expanded = advancedPanel.hidden;
    advancedPanel.hidden = !expanded;
    advancedToggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) requestAnimationFrame(() => nameInput.focus());
  });

  // Populate project picker from repo roots scan
  sendControlRequest('scan-repo-roots', {})
    .then((msg) => {
      pickerEl.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '-- Select a project --';
      defaultOpt.disabled = true;
      defaultOpt.selected = true;
      pickerEl.appendChild(defaultOpt);

      let hasProjects = false;
      for (const dir of (msg.directories || [])) {
        if (dir.projects.length === 0) continue;
        const group = document.createElement('optgroup');
        group.label = dir.root;
        for (const proj of dir.projects) {
          const opt = document.createElement('option');
          opt.value = JSON.stringify({ name: proj.name, path: proj.path });
          // Show "(N open)" suffix so users see at a glance which projects
          // already have sessions; selecting still works to spawn another.
          const existing = countSessionsByName(proj.name);
          opt.textContent = existing > 0 ? `${proj.name} (${existing} open)` : proj.name;
          group.appendChild(opt);
          hasProjects = true;
        }
        pickerEl.appendChild(group);
      }

      if (!hasProjects) {
        pickerEl.innerHTML = '';
        const emptyOpt = document.createElement('option');
        emptyOpt.disabled = true;
        emptyOpt.selected = true;
        emptyOpt.textContent = 'No projects found (configure repo roots in Settings)';
        pickerEl.appendChild(emptyOpt);
      }
    })
    .catch(() => {
      pickerEl.innerHTML = '';
      const failOpt = document.createElement('option');
      failOpt.disabled = true;
      failOpt.selected = true;
      failOpt.textContent = 'Scan failed';
      pickerEl.appendChild(failOpt);
    });

  pickerEl.addEventListener('change', () => {
    try {
      const proj = JSON.parse(pickerEl.value);
      // Auto-disambiguate name when project already has sessions so the
      // user can spawn multiple terminals on the same project path.
      nameInput.value = suggestSessionName(proj.name);
      pathInput.value = proj.path;
    } catch { /* picker value not valid JSON — ignore */ }
  });

  // Reset picker when user types manually in advanced fields
  nameInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });
  pathInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });

  // Confirm-on-check for skip-perms — forces deliberate acknowledgment
  skipPermsCheckbox.addEventListener('change', (e) => {
    if (!skipPermsCheckbox.checked) return;
    // Prevent commit until confirmed
    skipPermsCheckbox.checked = false;
    createConfirmDialog({
      title: 'Skip permission prompts?',
      message: 'This launches Claude with --dangerously-skip-permissions, granting unrestricted filesystem access. Only enable for projects you fully trust.',
      confirmLabel: 'Enable',
      danger: true,
      onConfirm: () => { skipPermsCheckbox.checked = true; },
    });
  });

  function close() {
    overlay.remove();
    opener?.focus?.();
  }

  function submit() {
    const name = nameInput.value.trim();
    const projectPath = pathInput.value.trim();

    if (!name || !projectPath) {
      errorEl.textContent = 'Both fields are required. Select a project or use Advanced options.';
      return;
    }

    // Auto-disambiguate so multiple terminals can target the same project.
    const msg = { type: 'add-session', name: suggestSessionName(name), path: projectPath };
    if (skipPermsCheckbox.checked) msg.dangerouslySkipPermissions = true;
    sendControlMsg(msg);

    close();
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', submit);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pathInput.focus(); });
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escHandler);
    }
  });

  // Focus picker after render
  requestAnimationFrame(() => pickerEl.focus());
}

// ── Settings dialog ──────────────────────────────────────────

export function createSettingsDialog() {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog dialog-settings';

  dialog.innerHTML = settingsHTML;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Ensure title id exists for aria-labelledby
  let titleEl = dialog.querySelector('#settings-title');
  if (!titleEl) {
    titleEl = dialog.querySelector('h2, h3, [class*="title"]');
    if (titleEl && !titleEl.id) titleEl.id = 'settings-title';
  }
  applyDialogAria(dialog, 'settings-title');

  // Tab switching
  const tabs = [...dialog.querySelectorAll('.settings-tab')];
  const panels = [...dialog.querySelectorAll('.settings-panel')];
  function activateTab(id) {
    for (const t of tabs) {
      const isActive = t.dataset.tab === id;
      t.setAttribute('aria-selected', String(isActive));
      t.tabIndex = isActive ? 0 : -1;
      t.classList.toggle('active', isActive);
    }
    for (const p of panels) {
      p.hidden = p.dataset.panel !== id;
    }
  }
  for (const t of tabs) {
    t.addEventListener('click', () => activateTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = tabs.indexOf(t);
      const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
      tabs[next].focus();
      activateTab(tabs[next].dataset.tab);
    });
  }

  const attentionInput = dialog.querySelector('#settings-attention');
  const escalationInput = dialog.querySelector('#settings-escalation');
  const watchdogInput = dialog.querySelector('#settings-watchdog');
  const rootListEl = dialog.querySelector('#settings-root-list');
  const rootInput = dialog.querySelector('#settings-root-input');
  const rootAddBtn = dialog.querySelector('#settings-root-add');
  const rootErrorEl = dialog.querySelector('#settings-root-error');
  const scrollbackInput = dialog.querySelector('#settings-scrollback');
  const replayBufferInput = dialog.querySelector('#settings-replay-buffer');
  const cursorBlinkCheckbox = dialog.querySelector('#settings-cursor-blink');
  const noFlickerCheckbox = dialog.querySelector('#settings-no-flicker');
  const noFlickerWarning = dialog.querySelector('#settings-noflicker-warning');
  const feedDebounceInput = dialog.querySelector('#settings-feed-debounce');
  const debugModeCheckbox = dialog.querySelector('#settings-debug-mode');
  const soundSelect = dialog.querySelector('#settings-sound');
  const editorCommandInput = dialog.querySelector('#settings-editor-command');
  const themeSelect = dialog.querySelector('#settings-theme');
  const errorEl = dialog.querySelector('#settings-error');
  const btnCancel = dialog.querySelector('#settings-cancel');
  const btnSave = dialog.querySelector('#settings-save');

  // Populate sound picker
  for (const opt of SOUND_OPTIONS) {
    const option = document.createElement('option');
    option.value = opt.id;
    option.textContent = opt.label;
    soundSelect.appendChild(option);
  }
  soundSelect.value = getSoundId();

  soundSelect.addEventListener('change', () => {
    setSoundId(soundSelect.value);
    playAlertSound(soundSelect.value);
  });

  // Populate theme picker
  for (const theme of getThemeList()) {
    const option = document.createElement('option');
    option.value = theme.id;
    option.textContent = theme.label;
    themeSelect.appendChild(option);
  }
  themeSelect.value = getThemeId();

  const themeWarning = dialog.querySelector('#settings-theme-warning');
  const initialTheme = getThemeId();

  themeSelect.addEventListener('change', () => {
    setThemeId(themeSelect.value);
    applyTheme(themeSelect.value);
    themeWarning.textContent = themeSelect.value === initialTheme
      ? ''
      : 'Restart the server for terminal colors to fully update.';
  });

  let initialNoFlicker = true;
  noFlickerCheckbox.addEventListener('change', () => {
    noFlickerWarning.textContent = noFlickerCheckbox.checked !== initialNoFlicker
      ? 'Restart sessions for this change to take effect.'
      : '';
  });

  let repoRoots = [];

  function close() {
    overlay.remove();
    opener?.focus?.();
  }

  function renderRootList() {
    rootListEl.innerHTML = '';
    if (repoRoots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-empty';
      empty.textContent = 'No repository roots configured. Add a path to enable project discovery.';
      rootListEl.appendChild(empty);
      return;
    }
    for (let i = 0; i < repoRoots.length; i++) {
      const item = document.createElement('div');
      item.className = 'settings-root-item';
      const pathSpan = document.createElement('span');
      pathSpan.className = 'settings-root-path';
      pathSpan.textContent = repoRoots[i];
      pathSpan.title = repoRoots[i];
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-settings-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => {
        repoRoots.splice(i, 1);
        renderRootList();
      });
      item.appendChild(pathSpan);
      item.appendChild(removeBtn);
      rootListEl.appendChild(item);
    }
  }

  function addRoot() {
    const val = rootInput.value.trim();
    rootErrorEl.textContent = '';
    if (!val) return;
    if (repoRoots.some(r => r.toLowerCase() === val.toLowerCase())) {
      rootErrorEl.textContent = 'Path already in list.';
      return;
    }
    repoRoots.push(val);
    rootInput.value = '';
    renderRootList();
  }

  const timeoutErrorEl = dialog.querySelector('#settings-timeout-error');

  function validateTimeouts() {
    timeoutErrorEl.textContent = '';
    for (const input of [attentionInput, escalationInput, watchdogInput, scrollbackInput, replayBufferInput, feedDebounceInput]) {
      const v = Number(input.value);
      if (!input.value || Number.isNaN(v) || v <= 0 || !Number.isInteger(v)) {
        timeoutErrorEl.textContent = 'All numeric fields must be positive integers';
        return false;
      }
    }
    return true;
  }

  function save() {
    errorEl.textContent = '';
    if (!validateTimeouts()) return;

    const settings = {
      attentionTimeoutSeconds: Number(attentionInput.value),
      waitingEscalationSeconds: Number(escalationInput.value),
      startingWatchdogSeconds: Number(watchdogInput.value),
      scrollback: Number(scrollbackInput.value),
      replayBufferKB: Number(replayBufferInput.value),
      cursorBlink: cursorBlinkCheckbox.checked,
      noFlicker: noFlickerCheckbox.checked,
      feedDebounceMs: Number(feedDebounceInput.value),
      debugMode: debugModeCheckbox.checked,
      editorCommand: editorCommandInput.value.trim(),
      repoRoots: repoRoots,
    };

    sendControlRequest('update-settings', { settings })
      .then((msg) => {
        if (msg.type === 'settings-error') {
          errorEl.textContent = msg.message;
        } else {
          close();
        }
      })
      .catch((err) => {
        errorEl.textContent = err.message || 'Failed to save settings.';
      });
  }

  // Load current settings
  sendControlRequest('get-settings', {})
    .then((msg) => {
      const s = msg.settings;
      attentionInput.value = s.attentionTimeoutSeconds;
      escalationInput.value = s.waitingEscalationSeconds;
      watchdogInput.value = s.startingWatchdogSeconds;
      scrollbackInput.value = s.scrollback ?? 50000;
      replayBufferInput.value = s.replayBufferKB ?? 512;
      cursorBlinkCheckbox.checked = !!s.cursorBlink;
      noFlickerCheckbox.checked = s.noFlicker ?? true;
      initialNoFlicker = noFlickerCheckbox.checked;
      feedDebounceInput.value = s.feedDebounceMs ?? 50;
      debugModeCheckbox.checked = !!s.debugMode;
      editorCommandInput.value = s.editorCommand ?? '';
      repoRoots = Array.isArray(s.repoRoots) ? [...s.repoRoots] : [];
      renderRootList();
    })
    .catch(() => {
      errorEl.textContent = 'Failed to load settings. Close and retry.';
    });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  btnCancel.addEventListener('click', close);
  btnSave.addEventListener('click', save);
  rootAddBtn.addEventListener('click', addRoot);
  rootInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addRoot(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escHandler);
    }
  });

  requestAnimationFrame(() => themeSelect.focus());
}

// ── Confirm dialog ───────────────────────────────────────────

export function createConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog';

  const titleId = 'confirm-dialog-title-' + Math.random().toString(36).slice(2);

  const titleEl = document.createElement('h3');
  titleEl.id = titleId;
  titleEl.className = 'dialog-title';
  titleEl.textContent = title;

  const msgEl = document.createElement('p');
  msgEl.className = 'dialog-message';
  msgEl.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn-dialog btn-dialog-cancel';
  btnCancel.textContent = 'Cancel';

  const btnConfirm = document.createElement('button');
  btnConfirm.className = danger ? 'btn-dialog btn-dialog-confirm btn-dialog-danger' : 'btn-dialog btn-dialog-confirm';
  btnConfirm.textContent = confirmLabel;

  actions.append(btnCancel, btnConfirm);
  dialog.append(titleEl, msgEl, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  applyDialogAria(dialog, titleId);

  function close() {
    overlay.remove();
    opener?.focus?.();
  }

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => {
    close();
    onConfirm?.();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escHandler);
    }
  });

  requestAnimationFrame(() => btnCancel.focus());
}
