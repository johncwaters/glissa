// Dialog factories that remain true overlays.

import addSessionHTML from './components/add-session-dialog.html?raw';
import { sendControlMsg, sendControlRequest } from './control-ws.ts';
import { el, query, queryTag } from './dom-helpers.ts';
import { applyDialogAria, buildDialogShell, createModalOverlay } from './session-card/modal.js';
import { DEFAULT_AGENT_ID, decideAgentPicker } from './session-card/agent-core.mjs';
import { countSessionsByName, suggestSessionName } from './session-card/naming.js';

interface OptionSettings {
  value?: string;
  disabled?: boolean;
  selected?: boolean;
}

interface RepoRootDirectory {
  root: string;
  projects: { name: string; path: string }[];
}

interface AgentChoice {
  id: string;
  label: string;
}

function option(text: string, { value, disabled = false, selected = false }: OptionSettings = {}) {
  const optionEl = el('option', null, text);
  if (value != null) optionEl.value = value;
  if (disabled) optionEl.disabled = true;
  if (selected) optionEl.selected = true;
  return optionEl;
}

export function createAddSessionDialog() {
  const { dialog, close } = createModalOverlay();
  dialog.innerHTML = addSessionHTML;
  applyDialogAria(dialog, 'add-session-title');

  const pickerEl = queryTag(dialog, '#add-session-picker', 'select');
  const agentLabelEl = query(dialog, '#add-session-agent-label');
  const agentSelectEl = queryTag(dialog, '#add-session-agent', 'select');
  const advancedToggle = queryTag(dialog, '#add-session-advanced-toggle', 'button');
  const advancedPanel = query(dialog, '#add-session-advanced');
  const nameInput = queryTag(dialog, '#add-session-name', 'input');
  const pathInput = queryTag(dialog, '#add-session-path', 'input');
  const requirePermsCheckbox = queryTag(dialog, '#add-session-require-perms', 'input');
  const errorEl = query(dialog, '#add-session-error');
  const btnCancel = queryTag(dialog, '#add-session-cancel', 'button');
  const btnConfirm = queryTag(dialog, '#add-session-confirm', 'button');

  advancedToggle.setAttribute('aria-expanded', 'false');
  advancedToggle.addEventListener('click', () => {
    const expanded = advancedPanel.hidden;
    advancedPanel.hidden = !expanded;
    advancedToggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) requestAnimationFrame(() => nameInput.focus());
  });

  sendControlRequest('scan-repo-roots', {})
    .then((message) => {
      pickerEl.textContent = '';
      pickerEl.appendChild(option('-- Select a project --', { value: '', disabled: true, selected: true }));
      let hasProjects = false;
      const directories = (message.directories as RepoRootDirectory[] | undefined) || [];
      for (const directory of directories) {
        if (directory.projects.length === 0) continue;
        const group = el('optgroup');
        group.label = directory.root;
        for (const project of directory.projects) {
          const existingCount = countSessionsByName(project.name);
          const label = existingCount > 0 ? `${project.name} (${existingCount} open)` : project.name;
          group.appendChild(option(label, { value: JSON.stringify({ name: project.name, path: project.path }) }));
          hasProjects = true;
        }
        pickerEl.appendChild(group);
      }
      if (hasProjects) return;
      pickerEl.textContent = '';
      pickerEl.appendChild(option('No projects found (configure repo roots in Settings)', { disabled: true, selected: true }));
    })
    .catch(() => {
      pickerEl.textContent = '';
      pickerEl.appendChild(option('Scan failed', { disabled: true, selected: true }));
    });

  pickerEl.addEventListener('change', () => {
    try {
      const project = JSON.parse(pickerEl.value) as { name: string; path: string };
      nameInput.value = suggestSessionName(project.name);
      pathInput.value = project.path;
    } catch {}
  });

  let selectedAgentId = DEFAULT_AGENT_ID;
  sendControlRequest('list-agents', {})
    .then((message) => {
      const decision = decideAgentPicker((message.agents as AgentChoice[] | undefined) || []);
      selectedAgentId = decision.selectedId;
      if (!decision.show) return;
      agentSelectEl.textContent = '';
      for (const agentOption of decision.options) {
        agentSelectEl.appendChild(option(agentOption.label, {
          value: agentOption.id,
          selected: agentOption.id === decision.selectedId,
        }));
      }
      agentLabelEl.hidden = false;
    })
    .catch(() => {});
  agentSelectEl.addEventListener('change', () => { selectedAgentId = agentSelectEl.value; });

  nameInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });
  pathInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });

  function submit() {
    const name = nameInput.value.trim();
    const projectPath = pathInput.value.trim();
    if (!name || !projectPath) {
      errorEl.textContent = 'Both fields are required. Select a project or use Advanced options.';
      return;
    }
    const message: Record<string, unknown> = { type: 'add-session', name: suggestSessionName(name), path: projectPath };
    if (requirePermsCheckbox.checked) message.dangerouslySkipPermissions = false;
    if (selectedAgentId && selectedAgentId !== DEFAULT_AGENT_ID) message.agent = selectedAgentId;
    sendControlMsg(message);
    close();
  }

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', submit);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') pathInput.focus();
  });
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  requestAnimationFrame(() => pickerEl.focus());
}

export function createPosthogReportDialog({
  issueId,
  issueTitle,
  format,
  content,
  message,
  error,
}: {
  issueId: string;
  issueTitle?: string;
  format?: string;
  content?: string;
  message?: string;
  error?: string;
}) {
  const { dialog, close, actions, btnCancel: btnClose } = buildDialogShell({
    title: 'Investigation report',
    dialogClass: 'dialog dialog-report',
    cancelLabel: 'Close',
  });
  const metaEl = el('div', 'dialog-report-meta', issueTitle || issueId || '');
  let bodyEl: HTMLIFrameElement | HTMLPreElement | null = null;
  if (format === 'html' && !error && !message) {
    const reportFrame = el('iframe', 'dialog-report-frame');
    reportFrame.setAttribute('sandbox', '');
    reportFrame.srcdoc = content || '';
    bodyEl = reportFrame;
  }
  if (!bodyEl) {
    bodyEl = el('pre', error ? 'dialog-report-body dialog-report-error' : 'dialog-report-body', error || message || content || '');
  }
  dialog.append(metaEl, bodyEl, actions);
  btnClose.addEventListener('click', close);
  requestAnimationFrame(() => btnClose.focus());
}
