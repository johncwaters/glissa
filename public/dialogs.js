// ── Dialogs module ────────────────────────────────────────────
// Owns Add Session and Settings dialog factory functions.

import { playAlertSound, SOUND_OPTIONS } from './alert-sound.js';
import addSessionHTML from './components/add-session-dialog.html?raw';
import settingsHTML from './components/settings-dialog.html?raw';
import { unionProjectSelection } from './settings-projects-core.mjs';
import { sendControlMsg, sendControlRequest } from './control-ws.js';
import { ensureNotificationPermission, notificationPermission, notificationsSupported } from './notifications.js';
import { el } from './dom-helpers.js';
import { applyDialogAria, buildDialogShell, createModalOverlay } from './session-card/modal.js';
import { DEFAULT_AGENT_ID, decideAgentPicker } from './session-card/agent-core.mjs';
import { countSessionsByName, suggestSessionName } from './session-card/naming.js';
import { SHORTCUT_GROUPS } from './shortcuts.mjs';
import { applyTheme, getThemeList } from './theme.js';
import { getSoundId, getThemeId, isNotificationsEnabled, setNotificationsEnabled, setSoundId, setThemeId } from './ui-prefs.js';
import { usageStatusLines } from './usage-panel.js';

function option(text, { value, disabled = false, selected = false } = {}) {
  const opt = el('option', null, text);
  if (value != null) opt.value = value;
  if (disabled) opt.disabled = true;
  if (selected) opt.selected = true;
  return opt;
}

let liveSettingsRtkSync = null;

export function applySettingsBroadcast(settings) {
  if (!settings) return;
  liveSettingsRtkSync?.(settings);
}

// ── Add Session dialog ────────────────────────────────────────

export function createAddSessionDialog() {
  const { dialog, close } = createModalOverlay();
  dialog.innerHTML = addSessionHTML;
  applyDialogAria(dialog, 'add-session-title');

  const pickerEl = dialog.querySelector('#add-session-picker');
  const agentLabelEl = dialog.querySelector('#add-session-agent-label');
  const agentSelectEl = dialog.querySelector('#add-session-agent');
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
      pickerEl.appendChild(option('-- Select a project --', { value: '', disabled: true, selected: true }));

      let hasProjects = false;
      for (const dir of (msg.directories || [])) {
        if (dir.projects.length === 0) continue;
        const group = el('optgroup');
        group.label = dir.root;
        for (const proj of dir.projects) {
          // Show "(N open)" suffix so users see at a glance which projects
          // already have sessions; selecting still works to spawn another.
          const existing = countSessionsByName(proj.name);
          const label = existing > 0 ? `${proj.name} (${existing} open)` : proj.name;
          group.appendChild(option(label, { value: JSON.stringify({ name: proj.name, path: proj.path }) }));
          hasProjects = true;
        }
        pickerEl.appendChild(group);
      }

      if (!hasProjects) {
        pickerEl.innerHTML = '';
        pickerEl.appendChild(option('No projects found (configure repo roots in Settings)', { disabled: true, selected: true }));
      }
    })
    .catch(() => {
      pickerEl.innerHTML = '';
      pickerEl.appendChild(option('Scan failed', { disabled: true, selected: true }));
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

  // Binary-gated: only resolvable agents offered, picker hidden if just one (decideAgentPicker).
  let selectedAgentId = DEFAULT_AGENT_ID;
  sendControlRequest('list-agents', {})
    .then((msg) => {
      const { show, options, selectedId } = decideAgentPicker(msg.agents || []);
      selectedAgentId = selectedId;
      if (!show) return;
      agentSelectEl.innerHTML = '';
      for (const opt of options) {
        agentSelectEl.appendChild(option(opt.label, { value: opt.id, selected: opt.id === selectedId }));
      }
      agentLabelEl.hidden = false;
    })
    .catch(() => { /* probe failed - keep the default agent and no picker */ });
  agentSelectEl.addEventListener('change', () => { selectedAgentId = agentSelectEl.value; });

  // Reset picker when user types manually in advanced fields
  nameInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });
  pathInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });

  // No confirm gate: YOLO is the default, so checking this box is the SAFE direction
  // (it asks the agent for permission prompts). Nothing dangerous to acknowledge here.

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
    // Only a non-default agent needs a field; a default choice keeps the message pre-picker-identical.
    if (selectedAgentId && selectedAgentId !== DEFAULT_AGENT_ID) msg.agent = selectedAgentId;
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

// An empty budget field means no ceiling, which the wire expresses as null. A blank or unparseable value
// is never coerced to 0: that would put the meter permanently over its limit.
function budgetFieldValue(input) {
  const raw = String(input?.value ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function createSettingsDialog(initialTab) {
  const { dialog, close } = createModalOverlay({ dialogClass: 'dialog dialog-settings' });
  dialog.innerHTML = settingsHTML;
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
  const rtkCheckbox = dialog.querySelector('#settings-rtk');
  const rtkWarning = dialog.querySelector('#settings-rtk-warning');
  const debugModeCheckbox = dialog.querySelector('#settings-debug-mode');
  const soundSelect = dialog.querySelector('#settings-sound');
  const notificationsCheckbox = dialog.querySelector('#settings-notifications');
  const notificationsHint = dialog.querySelector('#settings-notifications-hint');
  const themeSelect = dialog.querySelector('#settings-theme');
  const errorEl = dialog.querySelector('#settings-error');
  const btnCancel = dialog.querySelector('#settings-cancel');
  const btnSave = dialog.querySelector('#settings-save');

  // One bot serves three lanes (session notifications, PR review pings, PostHog pings), so the
  // credentials live on their own tab rather than inside whichever lane was written first.
  const telegramPanel = dialog.querySelector('#settings-panel-telegram');
  const telegramBotTokenInput = dialog.querySelector('#settings-telegram-bot-token');
  const telegramChatIdInput = dialog.querySelector('#settings-telegram-chat-id');
  // Gates a lane rather than the credentials, so it saves as its own top-level boolean.
  const telegramNotificationsCheckbox = dialog.querySelector('#settings-telegram-notifications');

  const prEnabledCheckbox = dialog.querySelector('#settings-pr-enabled');
  const prProjectsEl = dialog.querySelector('#settings-pr-projects');
  const prIntervalInput = dialog.querySelector('#settings-pr-interval');
  const prMaxReviewsInput = dialog.querySelector('#settings-pr-max-reviews');
  const prTimeoutInput = dialog.querySelector('#settings-pr-timeout');
  const prMergeMethodSelect = dialog.querySelector('#settings-pr-merge-method');

  const visionsPanel = dialog.querySelector('#settings-panel-visions');
  const visionsEnabledCheckbox = dialog.querySelector('#settings-visions-enabled');
  const visionsDispatchEnabledCheckbox = dialog.querySelector('#settings-visions-dispatch-enabled');
  const visionsQuietMsInput = dialog.querySelector('#settings-visions-quiet-ms');
  const visionsCooldownMsInput = dialog.querySelector('#settings-visions-cooldown-ms');
  const visionsMaxPerHourInput = dialog.querySelector('#settings-visions-max-per-hour');
  const visionsActivityMaxPerHourInput = dialog.querySelector('#settings-visions-activity-max-per-hour');
  const visionsDispatchTimeoutInput = dialog.querySelector('#settings-visions-dispatch-timeout');
  const visionsModelInput = dialog.querySelector('#settings-visions-model');
  const visionsAutoFixCheckbox = dialog.querySelector('#settings-visions-auto-fix');
  const visionsProjectsEl = dialog.querySelector('#settings-visions-projects');

  const millPanel = dialog.querySelector('#settings-panel-mill');
  const packsAutoRebuildCheckbox = dialog.querySelector('#settings-packs-auto-rebuild');
  const packReadTelemetryCheckbox = dialog.querySelector('#settings-pack-read-telemetry');
  const packDistillerEnabledCheckbox = dialog.querySelector('#settings-pack-distiller-enabled');
  const packDistillerIntervalInput = dialog.querySelector('#settings-pack-distiller-interval');
  const packDistillerTimeoutInput = dialog.querySelector('#settings-pack-distiller-timeout');
  const memoryEnabledCheckbox = dialog.querySelector('#settings-memory-enabled');
  const memoryRetainDaysInput = dialog.querySelector('#settings-memory-retain-days');
  const memoryMaxRecordCharsInput = dialog.querySelector('#settings-memory-max-record-chars');
  const memoryMaxRecordsPerKindInput = dialog.querySelector('#settings-memory-max-records-per-kind');
  const memoryDistillEnabledCheckbox = dialog.querySelector('#settings-memory-distill-enabled');
  const memoryDistillIntervalInput = dialog.querySelector('#settings-memory-distill-interval');
  const memoryDistillTimeoutInput = dialog.querySelector('#settings-memory-distill-timeout');
  const memoryDistillMaxClaimsInput = dialog.querySelector('#settings-memory-distill-max-claims');
  const memoryDistillQuietMsInput = dialog.querySelector('#settings-memory-distill-quiet-ms');
  const ingestEnabledCheckbox = dialog.querySelector('#settings-ingest-enabled');
  const ingestSourcesEl = dialog.querySelector('#settings-ingest-sources');

  let visionsHydrated = null;
  let visionsTouched = false;
  visionsPanel.addEventListener('input', () => { visionsTouched = true; });
  visionsPanel.addEventListener('change', () => { visionsTouched = true; });
  const shouldSaveVisions = () => visionsTouched || visionsHydrated !== null;

  let packDistillerHydrated = null;
  let memoryHydrated = null;
  let ingestHydrated = null;
  let millTouched = false;
  millPanel.addEventListener('input', () => { millTouched = true; });
  millPanel.addEventListener('change', () => { millTouched = true; });
  const shouldSaveMill = () => millTouched
    || packDistillerHydrated !== null || memoryHydrated !== null || ingestHydrated !== null;

  const posthogPanel = dialog.querySelector('#settings-panel-posthog');
  const posthogEnabledCheckbox = dialog.querySelector('#settings-posthog-enabled');
  const posthogHostInput = dialog.querySelector('#settings-posthog-host');
  const posthogApiKeyInput = dialog.querySelector('#settings-posthog-api-key');
  const posthogProjectsInput = dialog.querySelector('#settings-posthog-projects');
  const posthogIntervalInput = dialog.querySelector('#settings-posthog-interval');
  const posthogMaxInvestigationsInput = dialog.querySelector('#settings-posthog-max-investigations');
  const posthogTimeoutInput = dialog.querySelector('#settings-posthog-timeout');
  const posthogMinUsersInput = dialog.querySelector('#settings-posthog-min-users');
  const posthogEscalationInput = dialog.querySelector('#settings-posthog-escalation');
  const posthogAutoFixCheckbox = dialog.querySelector('#settings-posthog-auto-fix');
  const posthogFixTimeoutInput = dialog.querySelector('#settings-posthog-fix-timeout');
  const posthogTrafficEnabledCheckbox = dialog.querySelector('#settings-posthog-traffic-enabled');
  const posthogTrafficMultiplierInput = dialog.querySelector('#settings-posthog-traffic-multiplier');
  const posthogTrafficMinUsersInput = dialog.querySelector('#settings-posthog-traffic-min-users');
  const posthogTrafficCooldownInput = dialog.querySelector('#settings-posthog-traffic-cooldown');
  const posthogTrafficBaselineInput = dialog.querySelector('#settings-posthog-traffic-baseline');

  // The panel's fields are always populated with defaults, so saving them unconditionally would
  // materialize a posthog block into config.json for every operator who never opens this tab.
  // Send it only once the operator edits something here, or once the key already exists on disk.
  let posthogHydrated = null;
  let posthogTouched = false;
  posthogPanel.addEventListener('input', () => { posthogTouched = true; });
  posthogPanel.addEventListener('change', () => { posthogTouched = true; });
  const shouldSavePosthog = () => posthogTouched || posthogHydrated !== null;

  const usagePanel = dialog.querySelector('#settings-panel-usage');
  const usageEnabledCheckbox = dialog.querySelector('#settings-usage-enabled');
  const usageFetchPricingCheckbox = dialog.querySelector('#settings-usage-fetch-pricing');
  const usageCodexCheckbox = dialog.querySelector('#settings-usage-codex');
  const usageGrokCheckbox = dialog.querySelector('#settings-usage-grok');
  const usageBudgetDailyInput = dialog.querySelector('#settings-usage-budget-daily');
  const usageBudgetMonthlyInput = dialog.querySelector('#settings-usage-budget-monthly');
  const usageScanIntervalInput = dialog.querySelector('#settings-usage-scan-interval');
  const usageRetainDaysInput = dialog.querySelector('#settings-usage-retain-days');
  const usageCostModeSelect = dialog.querySelector('#settings-usage-cost-mode');
  const usageStatusEl = dialog.querySelector('#settings-usage-status');

  // Same materialization guard as the posthog tab: the fields always carry defaults, so saving them
  // unconditionally would write a usage block into config.json for every operator who never opens this
  // tab (and an absent block already means enabled-with-defaults).
  let usageHydrated = null;
  let usageTouched = false;
  usagePanel.addEventListener('input', () => { usageTouched = true; });
  usagePanel.addEventListener('change', () => { usageTouched = true; });
  const shouldSaveUsage = () => usageTouched || usageHydrated !== null;

  // Read-only readout of what the last usage report said, sourced from the panel rather than a second
  // request: the panel is mounted eagerly and already holds it.
  for (const line of usageStatusLines()) {
    usageStatusEl.appendChild(el('div', null, line));
  }

  // Same materialization guard for the credentials: an operator who never opens this tab does not get
  // an empty telegram block written into config.json by an unrelated save.
  let telegramHydrated = null;
  let telegramTouched = false;
  telegramPanel.addEventListener('input', () => { telegramTouched = true; });
  telegramPanel.addEventListener('change', () => { telegramTouched = true; });
  const shouldSaveTelegram = () => telegramTouched || telegramHydrated !== null;

  // Populate sound picker
  for (const opt of SOUND_OPTIONS) {
    soundSelect.appendChild(option(opt.label, { value: opt.id }));
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
    themeSelect.appendChild(option(theme.label, { value: theme.id }));
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
  let rtkAvailable = false;
  let rtkInstall = { status: 'idle' };

  function rtkWarningText() {
    if (!rtkCheckbox.checked || rtkAvailable) return '';
    if (rtkInstall.status === 'installing') return 'No rtk binary found. Glissa is installing it into ~/.glissa/bin now.';
    if (rtkInstall.status === 'failed') return `No rtk binary found. The last install attempt failed: ${rtkInstall.reason || 'unknown reason'}. Glissa retries on the next save.`;
    return 'No rtk binary found. Glissa will install it into ~/.glissa/bin when you save.';
  }

  function refreshRtkWarning() {
    rtkWarning.textContent = rtkWarningText();
  }

  // An install finishes long after the save that started it, so the broadcast updates an open dialog.
  liveSettingsRtkSync = (fresh) => {
    if (!dialog.isConnected) {
      liveSettingsRtkSync = null;
      return;
    }
    rtkAvailable = !!fresh.rtkAvailable;
    rtkInstall = fresh.rtkInstall || { status: 'idle' };
    refreshRtkWarning();
  };
  rtkCheckbox.addEventListener('change', refreshRtkWarning);

  function renderRootList() {
    rootListEl.innerHTML = '';
    if (repoRoots.length === 0) {
      rootListEl.appendChild(el('div', 'settings-empty', 'No repository roots configured. Add a path to enable project discovery.'));
      return;
    }
    for (let i = 0; i < repoRoots.length; i++) {
      const item = el('div', 'settings-root-item');
      const pathSpan = el('span', 'settings-root-path', repoRoots[i]);
      pathSpan.title = repoRoots[i];
      const removeBtn = el('button', 'btn-settings-remove', '\u00d7');
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
      prProjectsEl.appendChild(el('div', 'settings-empty', 'No projects configured. Add a session to pick a project here.'));
      return;
    }
    const checked = new Set(checkedIds);
    for (const proj of prProjectChoices) {
      const label = el('label', 'dialog-label dialog-checkbox-label');
      const input = el('input', 'dialog-checkbox');
      input.type = 'checkbox';
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

  function renderVisionsProjects(selected) {
    const checked = new Set(selected || []);
    visionsProjectsEl.innerHTML = '';
    for (const proj of prProjectChoices) {
      const label = el('label', 'dialog-label dialog-checkbox-label');
      const input = el('input', 'dialog-checkbox');
      input.type = 'checkbox';
      input.dataset.projectId = proj.id;
      input.checked = checked.has(proj.id);
      label.appendChild(input);
      label.appendChild(document.createTextNode(proj.name));
      visionsProjectsEl.appendChild(label);
    }
  }

  function checkedVisionsProjectIds() {
    return unionProjectSelection({
      checked: [...visionsProjectsEl.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.dataset.projectId),
      stored: Array.isArray(visionsHydrated?.projects) ? visionsHydrated.projects : [],
      rendered: prProjectChoices.map((proj) => proj.id),
    });
  }

  const POSTHOG_NUMERIC_INPUTS = () => [
    posthogIntervalInput, posthogMaxInvestigationsInput, posthogTimeoutInput,
    posthogMinUsersInput, posthogEscalationInput, posthogFixTimeoutInput,
    posthogTrafficMultiplierInput, posthogTrafficMinUsersInput,
    posthogTrafficCooldownInput, posthogTrafficBaselineInput,
  ];

  const VISIONS_NUMERIC_INPUTS = () => [
    visionsQuietMsInput, visionsCooldownMsInput, visionsMaxPerHourInput,
    visionsActivityMaxPerHourInput, visionsDispatchTimeoutInput,
  ];

  const MILL_NUMERIC_INPUTS = () => [
    packDistillerIntervalInput, packDistillerTimeoutInput,
    memoryRetainDaysInput, memoryMaxRecordCharsInput, memoryMaxRecordsPerKindInput,
    memoryDistillIntervalInput, memoryDistillTimeoutInput,
    memoryDistillMaxClaimsInput, memoryDistillQuietMsInput,
  ];

  const ingestSourceCheckboxes = () => [...ingestSourcesEl.querySelectorAll('input[data-ingest-source]')];

  function checkedIngestSources() {
    const sources = {};
    for (const box of ingestSourceCheckboxes()) sources[box.dataset.ingestSource] = { enabled: box.checked };
    return sources;
  }

  // Each field's own min/max attributes are the bounds, so a field that legitimately accepts zero
  // (the spike cooldown, meaning never mute) does not need a second list to be exempted from.
  function validateTimeouts() {
    errorEl.textContent = '';
    const inputs = [replayBufferInput, prIntervalInput, prMaxReviewsInput, prTimeoutInput];
    if (shouldSaveVisions()) inputs.push(...VISIONS_NUMERIC_INPUTS());
    if (shouldSaveMill()) inputs.push(...MILL_NUMERIC_INPUTS());
    if (shouldSavePosthog()) inputs.push(...POSTHOG_NUMERIC_INPUTS());
    if (shouldSaveUsage()) inputs.push(usageScanIntervalInput, usageRetainDaysInput);
    for (const input of inputs) {
      const v = Number(input.value);
      const floor = input.min === '' ? 1 : Number(input.min);
      const ceiling = input.max === '' ? Infinity : Number(input.max);
      if (!input.value || Number.isNaN(v) || !Number.isInteger(v) || v < floor || v > ceiling) {
        errorEl.textContent = 'Every numeric field must be a whole number within its allowed range';
        return false;
      }
    }
    return true;
  }

  // 'all' or a comma-separated list of numeric project ids. Returns null when the text is neither,
  // so save() can refuse rather than silently watching nothing.
  function parsePosthogProjects(raw) {
    const text = raw.trim();
    if (!text || text.toLowerCase() === 'all') return 'all';
    const ids = text.split(',').map((part) => part.trim()).filter((part) => part);
    if (ids.length === 0) return 'all';
    if (ids.some((id) => !/^\d+$/.test(id))) return null;
    return ids.map(Number);
  }

  function save() {
    errorEl.textContent = '';
    if (!validateTimeouts()) return;

    const settings = {
      replayBufferKB: Number(replayBufferInput.value),
      cursorBlink: cursorBlinkCheckbox.checked,
      checkForUpdates: checkUpdatesCheckbox.checked,
      autoResume: autoResumeCheckbox.checked,
      rtk: rtkCheckbox.checked,
      debugMode: debugModeCheckbox.checked,
      telegramNotifications: telegramNotificationsCheckbox.checked,
      packsAutoRebuild: packsAutoRebuildCheckbox.checked,
      packReadTelemetry: packReadTelemetryCheckbox.checked,
      repoRoots: repoRoots,
      prReview: {
        enabled: prEnabledCheckbox.checked,
        projects: checkedPrProjectIds(),
        intervalMinutes: Number(prIntervalInput.value),
        mergeMethod: prMergeMethodSelect.value,
        maxConcurrentReviews: Number(prMaxReviewsInput.value),
        reviewTimeoutSeconds: Number(prTimeoutInput.value),
      },
    };

    if (shouldSaveTelegram()) {
      settings.telegram = {
        botToken: telegramBotTokenInput.value.trim(),
        chatId: telegramChatIdInput.value.trim(),
      };
    }

    if (shouldSaveVisions()) {
      settings.visions = {
        ...(visionsHydrated || {}),
        enabled: visionsEnabledCheckbox.checked,
        autoFix: visionsAutoFixCheckbox.checked,
        projects: checkedVisionsProjectIds(),
        dispatch: {
          ...((visionsHydrated && typeof visionsHydrated.dispatch === 'object') ? visionsHydrated.dispatch : {}),
          enabled: visionsDispatchEnabledCheckbox.checked,
          quietMs: Number(visionsQuietMsInput.value),
          cooldownMs: Number(visionsCooldownMsInput.value),
          maxPerHour: Number(visionsMaxPerHourInput.value),
          activityMaxPerHour: Number(visionsActivityMaxPerHourInput.value),
          dispatchTimeoutSeconds: Number(visionsDispatchTimeoutInput.value),
          model: visionsModelInput.value.trim(),
        },
      };
    }

    if (shouldSaveMill()) {
      settings.packDistiller = {
        enabled: packDistillerEnabledCheckbox.checked,
        intervalHours: Number(packDistillerIntervalInput.value),
        timeoutSeconds: Number(packDistillerTimeoutInput.value),
      };
      settings.memory = {
        enabled: memoryEnabledCheckbox.checked,
        retainDays: Number(memoryRetainDaysInput.value),
        maxRecordChars: Number(memoryMaxRecordCharsInput.value),
        maxRecordsPerKind: Number(memoryMaxRecordsPerKindInput.value),
        distill: {
          enabled: memoryDistillEnabledCheckbox.checked,
          intervalMinutes: Number(memoryDistillIntervalInput.value),
          timeoutSeconds: Number(memoryDistillTimeoutInput.value),
          maxNewClaims: Number(memoryDistillMaxClaimsInput.value),
          quietMs: Number(memoryDistillQuietMsInput.value),
        },
      };
      // The legacy alias outranks retainDays wherever it already exists, so it has to move with it.
      if (memoryHydrated && memoryHydrated.memoryRetainDays != null) {
        settings.memory.memoryRetainDays = settings.memory.retainDays;
      }
      settings.ingest = {
        enabled: ingestEnabledCheckbox.checked,
        sources: checkedIngestSources(),
      };
    }

    if (shouldSavePosthog()) {
      const projects = parsePosthogProjects(posthogProjectsInput.value);
      if (projects === null) {
        errorEl.textContent = 'PostHog projects must be "all" or a comma-separated list of numeric ids.';
        return;
      }
      // Spread the hydrated object first so projectMap and any key this UI does not edit survive a save.
      settings.posthog = {
        ...(posthogHydrated || {}),
        enabled: posthogEnabledCheckbox.checked,
        host: posthogHostInput.value.trim(),
        apiKey: posthogApiKeyInput.value.trim(),
        projects,
        intervalMinutes: Number(posthogIntervalInput.value),
        maxConcurrentInvestigations: Number(posthogMaxInvestigationsInput.value),
        investigationTimeoutSeconds: Number(posthogTimeoutInput.value),
        minUsersToInvestigate: Number(posthogMinUsersInput.value),
        userEscalationThreshold: Number(posthogEscalationInput.value),
        autoFix: posthogAutoFixCheckbox.checked,
        fixTimeoutSeconds: Number(posthogFixTimeoutInput.value),
        trafficSpikeEnabled: posthogTrafficEnabledCheckbox.checked,
        trafficSpikeMultiplier: Number(posthogTrafficMultiplierInput.value),
        trafficSpikeMinUsers: Number(posthogTrafficMinUsersInput.value),
        trafficSpikeCooldownMinutes: Number(posthogTrafficCooldownInput.value),
        trafficSpikeBaselineDays: Number(posthogTrafficBaselineInput.value),
      };
    }

    if (shouldSaveUsage()) {
      // Spread the hydrated object first so keys this UI does not edit (sessionBlockHours,
      // extraProjectsDirs) survive a save.
      settings.usage = {
        ...(usageHydrated || {}),
        enabled: usageEnabledCheckbox.checked,
        fetchPricing: usageFetchPricingCheckbox.checked,
        vendors: { codex: usageCodexCheckbox.checked, grok: usageGrokCheckbox.checked },
        // Empty means no ceiling, which the wire expresses as null rather than 0 (a zero budget would read
        // as permanently over).
        budget: { dailyUsd: budgetFieldValue(usageBudgetDailyInput), monthlyUsd: budgetFieldValue(usageBudgetMonthlyInput) },
        scanIntervalMinutes: Number(usageScanIntervalInput.value),
        retainDays: Number(usageRetainDaysInput.value),
        costMode: usageCostModeSelect.value,
      };
    }

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
      rtkCheckbox.checked = !!s.rtk;
      rtkAvailable = !!s.rtkAvailable;
      rtkInstall = s.rtkInstall || { status: 'idle' };
      refreshRtkWarning();
      debugModeCheckbox.checked = !!s.debugMode;
      repoRoots = Array.isArray(s.repoRoots) ? [...s.repoRoots] : [];
      renderRootList();

      const pr = s.prReview || {};
      prEnabledCheckbox.checked = !!pr.enabled;
      prIntervalInput.value = pr.intervalMinutes ?? 15;
      prMaxReviewsInput.value = pr.maxConcurrentReviews ?? 3;
      prTimeoutInput.value = pr.reviewTimeoutSeconds ?? 900;
      prMergeMethodSelect.value = pr.mergeMethod ?? 'rebase';
      telegramHydrated = s.telegram && typeof s.telegram === 'object' ? s.telegram : null;
      const telegram = telegramHydrated || {};
      telegramBotTokenInput.value = telegram.botToken ?? '';
      telegramChatIdInput.value = telegram.chatId ?? '';
      telegramNotificationsCheckbox.checked = !!s.telegramNotifications;
      prProjectChoices = Array.isArray(s.projectChoices) ? s.projectChoices : [];
      renderPrProjects(pr.projects || []);

      visionsHydrated = s.visions && typeof s.visions === 'object' ? s.visions : null;
      const visions = visionsHydrated || {};
      const dispatch = visions.dispatch && typeof visions.dispatch === 'object' ? visions.dispatch : {};
      visionsEnabledCheckbox.checked = !!visions.enabled;
      visionsDispatchEnabledCheckbox.checked = !!dispatch.enabled;
      visionsQuietMsInput.value = dispatch.quietMs ?? 30000;
      visionsCooldownMsInput.value = dispatch.cooldownMs ?? 300000;
      visionsMaxPerHourInput.value = dispatch.maxPerHour ?? 6;
      visionsActivityMaxPerHourInput.value = dispatch.activityMaxPerHour ?? 2;
      visionsDispatchTimeoutInput.value = dispatch.dispatchTimeoutSeconds ?? 180;
      visionsModelInput.value = dispatch.model ?? '';
      visionsAutoFixCheckbox.checked = visions.autoFix === true;
      renderVisionsProjects(visions.projects || []);

      packsAutoRebuildCheckbox.checked = s.packsAutoRebuild !== false;
      packReadTelemetryCheckbox.checked = s.packReadTelemetry !== false;
      packDistillerHydrated = s.packDistiller && typeof s.packDistiller === 'object' ? s.packDistiller : null;
      const distiller = packDistillerHydrated || {};
      packDistillerEnabledCheckbox.checked = distiller.enabled === true;
      packDistillerIntervalInput.value = distiller.intervalHours ?? 24;
      packDistillerTimeoutInput.value = distiller.timeoutSeconds ?? 900;

      memoryHydrated = s.memory && typeof s.memory === 'object' ? s.memory : null;
      const memory = memoryHydrated || {};
      const memoryDistill = memory.distill && typeof memory.distill === 'object' ? memory.distill : {};
      memoryEnabledCheckbox.checked = memory.enabled === true;
      memoryRetainDaysInput.value = memory.memoryRetainDays ?? memory.retainDays ?? 365;
      memoryMaxRecordCharsInput.value = memory.maxRecordChars ?? 2000;
      memoryMaxRecordsPerKindInput.value = memory.maxRecordsPerKind ?? 2000;
      // Absent means on, matching how the lane reads the kill switch.
      memoryDistillEnabledCheckbox.checked = memoryDistill.enabled !== false;
      memoryDistillIntervalInput.value = memoryDistill.intervalMinutes ?? 1440;
      memoryDistillTimeoutInput.value = memoryDistill.timeoutSeconds ?? 900;
      memoryDistillMaxClaimsInput.value = memoryDistill.maxNewClaims ?? 20;
      memoryDistillQuietMsInput.value = memoryDistill.quietMs ?? 60000;

      ingestHydrated = s.ingest && typeof s.ingest === 'object' ? s.ingest : null;
      const ingest = ingestHydrated || {};
      const ingestSources = ingest.sources && typeof ingest.sources === 'object' ? ingest.sources : {};
      ingestEnabledCheckbox.checked = ingest.enabled === true;
      for (const box of ingestSourceCheckboxes()) {
        box.checked = ingestSources[box.dataset.ingestSource]?.enabled === true;
      }

      posthogHydrated = s.posthog && typeof s.posthog === 'object' ? s.posthog : null;
      const ph = posthogHydrated || {};
      posthogEnabledCheckbox.checked = !!ph.enabled;
      posthogHostInput.value = ph.host ?? 'https://us.posthog.com';
      // Matches how the Telegram bot token round-trips: the stored value is put back into a
      // password field rather than masked, so a save does not wipe the credential.
      posthogApiKeyInput.value = ph.apiKey ?? '';
      posthogProjectsInput.value = Array.isArray(ph.projects) ? ph.projects.join(', ') : 'all';
      posthogIntervalInput.value = ph.intervalMinutes ?? 15;
      posthogMaxInvestigationsInput.value = ph.maxConcurrentInvestigations ?? 2;
      posthogTimeoutInput.value = ph.investigationTimeoutSeconds ?? 900;
      posthogMinUsersInput.value = ph.minUsersToInvestigate ?? 1;
      posthogEscalationInput.value = ph.userEscalationThreshold ?? 25;
      // Absent means off: this lane pushes branches, so it is opted into, never defaulted into.
      posthogAutoFixCheckbox.checked = ph.autoFix === true;
      posthogFixTimeoutInput.value = ph.fixTimeoutSeconds ?? 1800;
      // Absent means on, matching how the poller reads the key.
      posthogTrafficEnabledCheckbox.checked = ph.trafficSpikeEnabled !== false;
      posthogTrafficMultiplierInput.value = ph.trafficSpikeMultiplier ?? 3;
      posthogTrafficMinUsersInput.value = ph.trafficSpikeMinUsers ?? 10;
      posthogTrafficCooldownInput.value = ph.trafficSpikeCooldownMinutes ?? 360;
      posthogTrafficBaselineInput.value = ph.trafficSpikeBaselineDays ?? 7;

      usageHydrated = s.usage && typeof s.usage === 'object' ? s.usage : null;
      const usage = usageHydrated || {};
      // Absent means on, matching how the lane reads the key.
      usageEnabledCheckbox.checked = usage.enabled !== false;
      usageFetchPricingCheckbox.checked = usage.fetchPricing !== false;
      usageCodexCheckbox.checked = usage.vendors?.codex !== false;
      usageGrokCheckbox.checked = usage.vendors?.grok !== false;
      usageBudgetDailyInput.value = usage.budget?.dailyUsd ?? '';
      usageBudgetMonthlyInput.value = usage.budget?.monthlyUsd ?? '';
      usageScanIntervalInput.value = usage.scanIntervalMinutes ?? 5;
      usageRetainDaysInput.value = usage.retainDays ?? 90;
      usageCostModeSelect.value = usage.costMode ?? 'auto';
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
    const groupEl = el('div', 'shortcut-group');
    groupEl.appendChild(el('div', 'shortcut-group-title', group.title));

    const dl = el('dl', 'shortcut-rows');
    for (const item of group.items) {
      const dt = el('dt', 'shortcut-keys');
      item.combos.forEach((chord, ci) => {
        if (ci > 0) dt.appendChild(el('span', 'shortcut-sep', '/'));
        chord.forEach((cap, ki) => {
          if (ki > 0) dt.appendChild(el('span', 'shortcut-sep', '+'));
          dt.appendChild(el('kbd', 'kbd', cap));
        });
      });
      dl.appendChild(dt);
      dl.appendChild(el('dd', 'shortcut-label', item.label));
    }
    groupEl.appendChild(dl);
    container.appendChild(groupEl);
  }
}

export function createPosthogReportDialog({ issueId, issueTitle, format, content, message, error }) {
  const { dialog, close, actions, btnCancel: btnClose } = buildDialogShell({
    title: 'Investigation report',
    dialogClass: 'dialog dialog-report',
    cancelLabel: 'Close',
  });

  const metaEl = el('div', 'dialog-report-meta', issueTitle || issueId || '');

  let bodyEl = null;
  if (format === 'html' && !error && !message) {
    bodyEl = el('iframe', 'dialog-report-frame');
    bodyEl.setAttribute('sandbox', '');
    bodyEl.srcdoc = content || '';
  }
  if (!bodyEl) {
    bodyEl = el('pre', error ? 'dialog-report-body dialog-report-error' : 'dialog-report-body', error || message || content || '');
  }

  dialog.append(metaEl, bodyEl, actions);

  btnClose.addEventListener('click', close);
  requestAnimationFrame(() => btnClose.focus());
}
