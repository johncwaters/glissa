// ── Dialogs module ────────────────────────────────────────────
// Owns Add Session and Settings dialog factory functions.

import { playAlertSound, SOUND_OPTIONS } from './alert-sound.js';
import addSessionHTML from './components/add-session-dialog.html?raw';
import settingsHTML from './components/settings-dialog.html?raw';
import { sendControlMsg, sendControlRequest } from './control-ws.js';
import { hasSessionByName } from './session-card.js';
import { applyTheme, getThemeList } from './theme.js';
import { getSoundId, getThemeId, setSoundId, setThemeId } from './ui-prefs.js';

// ── Add Session dialog ────────────────────────────────────────

export function createAddSessionDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog';

  dialog.innerHTML = addSessionHTML;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

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
        const projects = dir.projects.filter(p => !hasSessionByName(p.name));
        if (projects.length === 0) continue;
        const group = document.createElement('optgroup');
        group.label = dir.root;
        for (const proj of projects) {
          const opt = document.createElement('option');
          opt.value = JSON.stringify({ name: proj.name, path: proj.path });
          opt.textContent = proj.name;
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
      nameInput.value = proj.name;
      pathInput.value = proj.path;
    } catch { /* picker value not valid JSON — ignore */ }
  });

  // Reset picker when user types manually in advanced fields
  nameInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });
  pathInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });

  function close() {
    overlay.remove();
  }

  function submit() {
    const name = nameInput.value.trim();
    const projectPath = pathInput.value.trim();

    if (!name || !projectPath) {
      errorEl.textContent = 'Both fields are required. Select a project or use Advanced options.';
      return;
    }

    if (hasSessionByName(name)) {
      errorEl.textContent = `Session "${name}" already exists.`;
      return;
    }

    const msg = { type: 'add-session', name, path: projectPath };
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
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog dialog-settings';

  dialog.innerHTML = settingsHTML;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const attentionInput = dialog.querySelector('#settings-attention');
  const escalationInput = dialog.querySelector('#settings-escalation');
  const watchdogInput = dialog.querySelector('#settings-watchdog');
  const rootListEl = dialog.querySelector('#settings-root-list');
  const rootInput = dialog.querySelector('#settings-root-input');
  const rootAddBtn = dialog.querySelector('#settings-root-add');
  const rootErrorEl = dialog.querySelector('#settings-root-error');
  const soundSelect = dialog.querySelector('#settings-sound');
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

  let repoRoots = [];

  function close() {
    overlay.remove();
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
    for (const input of [attentionInput, escalationInput, watchdogInput]) {
      const v = Number(input.value);
      if (!input.value || Number.isNaN(v) || v <= 0 || !Number.isInteger(v)) {
        timeoutErrorEl.textContent = 'All timeouts must be positive integers';
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

  requestAnimationFrame(() => attentionInput.focus());
}
