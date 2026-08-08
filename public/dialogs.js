// ── Dialogs module ────────────────────────────────────────────
// Owns Add Session and Settings dialog factory functions.

import { playAlertSound, SOUND_OPTIONS } from './alert-sound.js';
import addSessionHTML from './components/add-session-dialog.html?raw';
import settingsHTML from './components/settings-dialog.html?raw';
import { sendControlMsg, sendControlRequest } from './control-ws.js';
import { ensureNotificationPermission, notificationPermission, notificationsSupported } from './notifications.js';
import { createModalOverlay, trapFocus } from './session-card/modal.js';
import { countSessionsByName, suggestSessionName } from './session-card/naming.js';
import { SHORTCUT_GROUPS } from './shortcuts.mjs';
import { applyTheme, getThemeList } from './theme.js';
import { getSoundId, getThemeId, isNotificationsEnabled, setNotificationsEnabled, setSoundId, setThemeId } from './ui-prefs.js';

// ── Shared dialog ARIA + focus trap helpers ──────────────────

function applyDialogAria(dialog, titleId) {
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  trapFocus(dialog);
}

// ── Add Session dialog ────────────────────────────────────────

export function createAddSessionDialog() {
  const { dialog, close } = createModalOverlay();
  dialog.innerHTML = addSessionHTML;

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
  const requirePermsCheckbox = dialog.querySelector('#add-session-require-perms');
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
    } catch { /* picker value not valid JSON - ignore */ }
  });

  // Reset picker when user types manually in advanced fields
  nameInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });
  pathInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });

  // No confirm gate: YOLO is the default, so checking this box is the SAFE direction
  // (it asks Claude for permission prompts). Nothing dangerous to acknowledge here.

  function submit() {
    const name = nameInput.value.trim();
    const projectPath = pathInput.value.trim();

    if (!name || !projectPath) {
      errorEl.textContent = 'Both fields are required. Select a project or use Advanced options.';
      return;
    }

    // Auto-disambiguate so multiple terminals can target the same project.
    const msg = { type: 'add-session', name: suggestSessionName(name), path: projectPath };
    // Default is YOLO; only send the opt-out flag when the operator wants permission prompts.
    if (requirePermsCheckbox.checked) msg.dangerouslySkipPermissions = false;
    sendControlMsg(msg);

    close();
  }

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', submit);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pathInput.focus(); });
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  // Focus picker after render
  requestAnimationFrame(() => pickerEl.focus());
}

// ── Settings dialog ──────────────────────────────────────────

export function createSettingsDialog(initialTab) {
  const { dialog, close } = createModalOverlay({ dialogClass: 'dialog dialog-settings' });
  dialog.innerHTML = settingsHTML;

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
    // Shortcuts is a read-only reference tab: there is nothing to save, so hide Save and let Cancel
    // read as a plain Close. Every other tab restores the Save / Cancel pair. (btnSave / btnCancel are
    // declared below; this only runs from a click handler or the post-setup initial-tab call.)
    const readOnly = id === 'shortcuts';
    if (btnSave) btnSave.hidden = readOnly;
    if (btnCancel) btnCancel.textContent = readOnly ? 'Close' : 'Cancel';
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

  const rootListEl = dialog.querySelector('#settings-root-list');
  const rootInput = dialog.querySelector('#settings-root-input');
  const rootAddBtn = dialog.querySelector('#settings-root-add');
  const rootErrorEl = dialog.querySelector('#settings-root-error');
  const replayBufferInput = dialog.querySelector('#settings-replay-buffer');
  const cursorBlinkCheckbox = dialog.querySelector('#settings-cursor-blink');
  const checkUpdatesCheckbox = dialog.querySelector('#settings-check-updates');
  const autoResumeCheckbox = dialog.querySelector('#settings-auto-resume');
  const debugModeCheckbox = dialog.querySelector('#settings-debug-mode');
  const soundSelect = dialog.querySelector('#settings-sound');
  const notificationsCheckbox = dialog.querySelector('#settings-notifications');
  const notificationsHint = dialog.querySelector('#settings-notifications-hint');
  const editorCommandInput = dialog.querySelector('#settings-editor-command');
  const themeSelect = dialog.querySelector('#settings-theme');
  const errorEl = dialog.querySelector('#settings-error');
  const btnCancel = dialog.querySelector('#settings-cancel');
  const btnSave = dialog.querySelector('#settings-save');

  const prEnabledCheckbox = dialog.querySelector('#settings-pr-enabled');
  const prBotTokenInput = dialog.querySelector('#settings-pr-bot-token');
  const prChatIdInput = dialog.querySelector('#settings-pr-chat-id');
  // Shares the bot credentials above but gates a separate lane (session notifications), so it saves
  // as its own top-level boolean rather than anything under prReview.
  const telegramNotificationsCheckbox = dialog.querySelector('#settings-telegram-notifications');
  const prProjectsEl = dialog.querySelector('#settings-pr-projects');
  const prIntervalInput = dialog.querySelector('#settings-pr-interval');
  const prMaxReviewsInput = dialog.querySelector('#settings-pr-max-reviews');
  const prTimeoutInput = dialog.querySelector('#settings-pr-timeout');
  const prMergeMethodSelect = dialog.querySelector('#settings-pr-merge-method');

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

  // Desktop notifications (client-side pref, applied immediately like sound/theme)
  const DEFAULT_NOTIF_HINT = 'Native browser notification when a session needs attention while the dashboard is in the background';
  function refreshNotificationsHint() {
    if (!notificationsSupported()) {
      notificationsHint.textContent = 'Desktop notifications are unavailable for this page.';
      return;
    }
    if (notificationsCheckbox.checked && notificationPermission() === 'denied') {
      notificationsHint.textContent = 'Blocked by the browser. Allow notifications for this site to enable them.';
      return;
    }
    notificationsHint.textContent = DEFAULT_NOTIF_HINT;
  }
  notificationsCheckbox.checked = isNotificationsEnabled() && notificationsSupported();
  notificationsCheckbox.disabled = !notificationsSupported();
  refreshNotificationsHint();

  notificationsCheckbox.addEventListener('change', async () => {
    setNotificationsEnabled(notificationsCheckbox.checked);
    if (notificationsCheckbox.checked) {
      await ensureNotificationPermission(); // real user gesture: reliable prompt
    }
    refreshNotificationsHint();
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

  let prProjectChoices = [];

  function renderPrProjects(checkedIds) {
    prProjectsEl.textContent = '';
    if (prProjectChoices.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-empty';
      empty.textContent = 'No projects configured. Add a session to pick a project here.';
      prProjectsEl.appendChild(empty);
      return;
    }
    const checked = new Set(checkedIds);
    for (const proj of prProjectChoices) {
      const label = document.createElement('label');
      label.className = 'dialog-label dialog-checkbox-label';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'dialog-checkbox';
      input.dataset.projectId = proj.id;
      input.checked = checked.has(proj.id);
      label.appendChild(input);
      label.appendChild(document.createTextNode(proj.name));
      prProjectsEl.appendChild(label);
    }
  }

  function checkedPrProjectIds() {
    return [...prProjectsEl.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.dataset.projectId);
  }

  function validateTimeouts() {
    errorEl.textContent = '';
    for (const input of [replayBufferInput, prIntervalInput, prMaxReviewsInput, prTimeoutInput]) {
      const v = Number(input.value);
      if (!input.value || Number.isNaN(v) || v <= 0 || !Number.isInteger(v)) {
        errorEl.textContent = 'All numeric fields must be positive integers';
        return false;
      }
    }
    return true;
  }

  function save() {
    errorEl.textContent = '';
    if (!validateTimeouts()) return;

    const settings = {
      replayBufferKB: Number(replayBufferInput.value),
      cursorBlink: cursorBlinkCheckbox.checked,
      checkForUpdates: checkUpdatesCheckbox.checked,
      autoResume: autoResumeCheckbox.checked,
      debugMode: debugModeCheckbox.checked,
      telegramNotifications: telegramNotificationsCheckbox.checked,
      editorCommand: editorCommandInput.value.trim(),
      repoRoots: repoRoots,
      prReview: {
        enabled: prEnabledCheckbox.checked,
        projects: checkedPrProjectIds(),
        intervalMinutes: Number(prIntervalInput.value),
        mergeMethod: prMergeMethodSelect.value,
        maxConcurrentReviews: Number(prMaxReviewsInput.value),
        reviewTimeoutSeconds: Number(prTimeoutInput.value),
      },
      telegram: {
        botToken: prBotTokenInput.value.trim(),
        chatId: prChatIdInput.value.trim(),
      },
    };

    sendControlRequest('update-settings', { settings })
      .then((msg) => {
        if (msg.type === 'settings-error') { errorEl.textContent = msg.message; return; }
        close();
      })
      .catch((err) => {
        errorEl.textContent = err.message || 'Failed to save settings.';
      });
  }

  // Load current settings
  sendControlRequest('get-settings', {})
    .then((msg) => {
      const s = msg.settings;
      replayBufferInput.value = s.replayBufferKB ?? 512;
      cursorBlinkCheckbox.checked = !!s.cursorBlink;
      checkUpdatesCheckbox.checked = s.checkForUpdates !== false;
      autoResumeCheckbox.checked = s.autoResume !== false;
      debugModeCheckbox.checked = !!s.debugMode;
      editorCommandInput.value = s.editorCommand ?? '';
      repoRoots = Array.isArray(s.repoRoots) ? [...s.repoRoots] : [];
      renderRootList();

      const pr = s.prReview || {};
      prEnabledCheckbox.checked = !!pr.enabled;
      prIntervalInput.value = pr.intervalMinutes ?? 15;
      prMaxReviewsInput.value = pr.maxConcurrentReviews ?? 3;
      prTimeoutInput.value = pr.reviewTimeoutSeconds ?? 900;
      prMergeMethodSelect.value = pr.mergeMethod ?? 'rebase';
      const telegram = s.telegram || {};
      prBotTokenInput.value = telegram.botToken ?? '';
      prChatIdInput.value = telegram.chatId ?? '';
      telegramNotificationsCheckbox.checked = !!s.telegramNotifications;
      prProjectChoices = Array.isArray(s.projectChoices) ? s.projectChoices : [];
      renderPrProjects(pr.projects || []);
    })
    .catch(() => {
      errorEl.textContent = 'Failed to load settings. Close and retry.';
    });

  // Shortcuts tab: render the reference list from the shared data module and stamp the build version.
  const versionEl = dialog.querySelector('#settings-version');
  if (versionEl) {
    const v = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
    versionEl.textContent = v ? `v${v}` : 'version unknown';
  }
  const shortcutGroupsEl = dialog.querySelector('#settings-shortcut-groups');
  if (shortcutGroupsEl) renderShortcutGroups(shortcutGroupsEl);

  btnCancel.addEventListener('click', close);
  btnSave.addEventListener('click', save);
  rootAddBtn.addEventListener('click', addRoot);
  rootInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addRoot(); });

  // Open on a requested tab (the header ? button / ? key open straight to Shortcuts). Focus the tab
  // itself in that case, since the General theme picker lives in a now-hidden panel.
  const startTab = initialTab && tabs.some((t) => t.dataset.tab === initialTab) ? initialTab : null;
  if (startTab) activateTab(startTab);
  requestAnimationFrame(() => {
    const startTabEl = startTab && tabs.find((t) => t.dataset.tab === startTab);
    (startTabEl || themeSelect).focus();
  });
}

// Build the Shortcuts tab body from the shared SHORTCUT_GROUPS data: one labelled group per section,
// each a <dl> of key chips (<kbd>) and their descriptions. Built with createElement (not innerHTML)
// so the captions render as text, never markup.
function renderShortcutGroups(container) {
  container.textContent = '';
  for (const group of SHORTCUT_GROUPS) {
    const groupEl = document.createElement('div');
    groupEl.className = 'shortcut-group';
    const titleEl = document.createElement('div');
    titleEl.className = 'shortcut-group-title';
    titleEl.textContent = group.title;
    groupEl.appendChild(titleEl);

    const dl = document.createElement('dl');
    dl.className = 'shortcut-rows';
    for (const item of group.items) {
      const dt = document.createElement('dt');
      dt.className = 'shortcut-keys';
      item.combos.forEach((chord, ci) => {
        if (ci > 0) dt.appendChild(shortcutSep('/'));
        chord.forEach((cap, ki) => {
          if (ki > 0) dt.appendChild(shortcutSep('+'));
          const kbd = document.createElement('kbd');
          kbd.className = 'kbd';
          kbd.textContent = cap;
          dt.appendChild(kbd);
        });
      });
      const dd = document.createElement('dd');
      dd.className = 'shortcut-label';
      dd.textContent = item.label;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    groupEl.appendChild(dl);
    container.appendChild(groupEl);
  }
}

function shortcutSep(ch) {
  const s = document.createElement('span');
  s.className = 'shortcut-sep';
  s.textContent = ch;
  return s;
}

// ── Confirm dialog ───────────────────────────────────────────

export function createConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  const { dialog, close } = createModalOverlay();

  const titleId = `confirm-dialog-title-${Math.random().toString(36).slice(2)}`;

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

  applyDialogAria(dialog, titleId);

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => {
    close();
    onConfirm?.();
  });

  requestAnimationFrame(() => btnCancel.focus());
}
