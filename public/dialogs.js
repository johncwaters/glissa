// ── Dialogs module ────────────────────────────────────────────
// Owns Add Session and Settings dialog factory functions.

import { getSessionUIs } from './session-card.js';
import { sendControlRequest, sendControlMsg } from './control-ws.js';

// ── Add Session dialog ────────────────────────────────────────

export function createAddSessionDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog';

  dialog.innerHTML = String.raw`
    <div class="dialog-title">Add Session</div>
    <label class="dialog-label">
      Name
      <input type="text" class="dialog-input" id="add-session-name" placeholder="my-project" autocomplete="off" spellcheck="false">
    </label>
    <label class="dialog-label">
      Path
      <input type="text" class="dialog-input" id="add-session-path" placeholder="C:\Users\...\my-project" autocomplete="off" spellcheck="false">
    </label>
    <label class="dialog-label">
      Or pick from discovered projects:
      <select class="dialog-input project-picker" id="add-session-picker">
        <option value="" disabled selected>Scanning...</option>
      </select>
    </label>
    <div class="dialog-error" id="add-session-error"></div>
    <div class="dialog-actions">
      <button class="btn-dialog btn-dialog-cancel" id="add-session-cancel">Cancel</button>
      <button class="btn-dialog btn-dialog-confirm" id="add-session-confirm">Add</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const nameInput = dialog.querySelector('#add-session-name');
  const pathInput = dialog.querySelector('#add-session-path');
  const pickerEl = dialog.querySelector('#add-session-picker');
  const errorEl = dialog.querySelector('#add-session-error');
  const btnCancel = dialog.querySelector('#add-session-cancel');
  const btnConfirm = dialog.querySelector('#add-session-confirm');

  const sessionUIs = getSessionUIs();

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
        const projects = dir.projects.filter(p => !sessionUIs.has(p.name));
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

  // Reset picker when user types manually
  nameInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });
  pathInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });

  function close() {
    overlay.remove();
  }

  function submit() {
    const name = nameInput.value.trim();
    const projectPath = pathInput.value.trim();

    if (!name || !projectPath) {
      errorEl.textContent = 'Both fields are required.';
      return;
    }

    if (sessionUIs.has(name)) {
      errorEl.textContent = `Session "${name}" already exists.`;
      return;
    }

    sendControlMsg({ type: 'add-session', name, path: projectPath });

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

  // Focus name input after render
  requestAnimationFrame(() => nameInput.focus());
}

// ── Settings dialog ──────────────────────────────────────────

export function createSettingsDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog dialog-settings';

  dialog.innerHTML = String.raw`
    <div class="dialog-title">Settings</div>
    <label class="dialog-label">
      Attention Timeout (seconds)
      <input type="number" class="dialog-input" id="settings-attention" min="1" autocomplete="off">
      <span class="dialog-field-error" id="settings-attention-error"></span>
    </label>
    <label class="dialog-label">
      Waiting Escalation (seconds)
      <input type="number" class="dialog-input" id="settings-escalation" min="1" autocomplete="off">
      <span class="dialog-field-error" id="settings-escalation-error"></span>
    </label>
    <label class="dialog-label">
      Starting Watchdog (seconds)
      <input type="number" class="dialog-input" id="settings-watchdog" min="1" autocomplete="off">
      <span class="dialog-field-error" id="settings-watchdog-error"></span>
    </label>
    <div class="settings-section">
      <div class="settings-section-title">Repository Roots</div>
      <div class="settings-root-list" id="settings-root-list"></div>
      <div class="settings-add-row">
        <input type="text" class="dialog-input settings-root-input" id="settings-root-input" placeholder="C:\Users\...\repos" autocomplete="off" spellcheck="false">
        <button class="btn-dialog btn-dialog-confirm btn-settings-add" id="settings-root-add">Add</button>
      </div>
      <div class="dialog-field-error" id="settings-root-error"></div>
    </div>
    <div class="dialog-error" id="settings-error"></div>
    <div class="dialog-actions">
      <button class="btn-dialog btn-dialog-cancel" id="settings-cancel">Cancel</button>
      <button class="btn-dialog btn-dialog-confirm" id="settings-save">Save</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const attentionInput = dialog.querySelector('#settings-attention');
  const escalationInput = dialog.querySelector('#settings-escalation');
  const watchdogInput = dialog.querySelector('#settings-watchdog');
  const rootListEl = dialog.querySelector('#settings-root-list');
  const rootInput = dialog.querySelector('#settings-root-input');
  const rootAddBtn = dialog.querySelector('#settings-root-add');
  const rootErrorEl = dialog.querySelector('#settings-root-error');
  const errorEl = dialog.querySelector('#settings-error');
  const btnCancel = dialog.querySelector('#settings-cancel');
  const btnSave = dialog.querySelector('#settings-save');

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

  function validateTimeouts() {
    let valid = true;
    const fields = [
      { input: attentionInput, errorEl: dialog.querySelector('#settings-attention-error') },
      { input: escalationInput, errorEl: dialog.querySelector('#settings-escalation-error') },
      { input: watchdogInput, errorEl: dialog.querySelector('#settings-watchdog-error') },
    ];
    for (const f of fields) {
      const v = Number(f.input.value);
      f.errorEl.textContent = '';
      if (!f.input.value || Number.isNaN(v) || v <= 0 || !Number.isInteger(v)) {
        f.errorEl.textContent = 'Must be a positive integer';
        valid = false;
      }
    }
    return valid;
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
