import type { PlanResponseFrame, PlanReviewState, PlanRevisionBody } from '#shared/contracts/plan-review.ts';
import { el } from '../dom-helpers.ts';
import { parsePlanMarkdown, planInlineText } from './plan-markdown-core.ts';
import { renderPlanBlocks } from './plan-render.ts';
import { createPlanViewModel } from './plan-view-core.ts';

export type PlanResponse = PlanResponseFrame;

export interface PlanFaceUpdate {
  state?: PlanReviewState;
  response?: PlanResponse;
  isConnected?: boolean;
  requestFailed?: boolean;
}

export interface PlanFaceDeps {
  requestPlan: (id: string, agentId: string | null, revision?: number) => boolean;
  showTerminal: () => void;
}

const MAX_CACHED_BODIES_PER_SESSION = 12;
const bodyCacheBySession = new Map<string, Map<string, string>>();

function bodyKey(agentId: string | null, revision: number) {
  return JSON.stringify([agentId, revision]);
}

function cachePlanBody(sessionId: string, body: PlanRevisionBody) {
  let sessionCache = bodyCacheBySession.get(sessionId);
  if (!sessionCache) {
    sessionCache = new Map();
    bodyCacheBySession.set(sessionId, sessionCache);
  }
  const key = bodyKey(body.agentId, body.revision);
  sessionCache.delete(key);
  sessionCache.set(key, body.plan);
  while (sessionCache.size > MAX_CACHED_BODIES_PER_SESSION) {
    const oldestKey = sessionCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    sessionCache.delete(oldestKey);
  }
}

export function dropPlanBodyCache(sessionId: string) {
  bodyCacheBySession.delete(sessionId);
}

function bodyFromCache(sessionId: string | null, agentId: string | null, revision: number | null) {
  if (!sessionId || revision === null) return null;
  return bodyCacheBySession.get(sessionId)?.get(bodyKey(agentId, revision)) ?? null;
}

export function createPlanFace(deps: PlanFaceDeps) {
  const root = el('section', 'plan-face');
  root.hidden = true;

  const head = el('header', 'plan-head');
  const tabs = el('div', 'plan-tabs');
  tabs.setAttribute('role', 'tablist');
  const revisionPicker = el('select', 'plan-revision-picker');
  revisionPicker.setAttribute('aria-label', 'Plan revision');
  const terminalButton = el('button', 'plan-terminal-button', 'Terminal');
  terminalButton.type = 'button';
  terminalButton.addEventListener('click', deps.showTerminal);
  head.append(tabs, revisionPicker, terminalButton);

  const narrowHeadingPicker = el('select', 'plan-heading-picker');
  narrowHeadingPicker.setAttribute('aria-label', 'Plan section');
  const bodyLayout = el('div', 'plan-body-layout');
  const headingRail = el('nav', 'plan-heading-rail');
  headingRail.setAttribute('aria-label', 'Plan sections');
  const readingColumn = el('article', 'plan-reading-column');
  bodyLayout.append(headingRail, readingColumn);

  const actionBar = el('footer', 'plan-action-bar');
  const status = el('span', 'plan-status');
  status.setAttribute('role', 'status');
  const actions = el('div', 'plan-actions');
  actionBar.append(status, actions);
  root.append(head, narrowHeadingPicker, bodyLayout, actionBar);

  let sessionId: string | null = null;
  let state: PlanReviewState = { reviews: [] };
  let selectedAgentId: string | null = null;
  let selectedRevision: number | null = null;
  let isConnected = true;
  let lastRequestKey = '';
  let failedRequestKey = '';

  function scrollToHeading(id: string) {
    const heading = readingColumn.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  narrowHeadingPicker.addEventListener('change', () => scrollToHeading(narrowHeadingPicker.value));

  revisionPicker.addEventListener('change', () => {
    selectedRevision = Number(revisionPicker.value) || null;
    render();
  });

  function requestKey() {
    return `${sessionId ?? ''}:${selectedAgentId ?? 'main'}:${selectedRevision ?? 'latest'}`;
  }

  function requestSelectedBody() {
    if (!sessionId) return;
    const key = requestKey();
    if (lastRequestKey === key) return;
    if (!deps.requestPlan(sessionId, selectedAgentId, selectedRevision ?? undefined)) return;
    lastRequestKey = key;
  }

  function renderHeadings(body: string | null) {
    headingRail.replaceChildren();
    narrowHeadingPicker.replaceChildren();
    if (body === null) return;
    const blocks = parsePlanMarkdown(body);
    readingColumn.replaceChildren(renderPlanBlocks(blocks));
    for (const block of blocks) {
      if (block.type !== 'heading') continue;
      const label = planInlineText(block.children);
      const button = el('button', 'plan-heading-link', label);
      button.type = 'button';
      button.dataset.level = String(block.level);
      button.addEventListener('click', () => scrollToHeading(block.id));
      headingRail.append(button);
      const option = el('option', null, label);
      option.value = block.id;
      narrowHeadingPicker.append(option);
    }
  }

  function render() {
    const selection = createPlanViewModel({ state, selectedAgentId, selectedRevision, body: null, isConnected });
    selectedAgentId = selection.selectedAgentId;
    selectedRevision = selection.selectedRevision;
    const body = bodyFromCache(sessionId, selectedAgentId, selectedRevision);
    const model = createPlanViewModel({ state, selectedAgentId, selectedRevision, body, isConnected });

    tabs.replaceChildren();
    for (const tab of model.tabs) {
      const button = el('button', 'plan-tab', tab.label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab.selected));
      button.addEventListener('click', () => {
        selectedAgentId = tab.agentId;
        selectedRevision = null;
        lastRequestKey = '';
        failedRequestKey = '';
        render();
      });
      tabs.append(button);
    }

    revisionPicker.replaceChildren();
    for (const revision of model.revisions) {
      const option = el('option', null, revision.label);
      option.value = String(revision.revision);
      option.selected = revision.selected;
      option.title = new Date(revision.receivedAt).toLocaleString();
      revisionPicker.append(option);
    }
    revisionPicker.hidden = model.revisions.length < 2;
    status.textContent = model.status;

    actions.replaceChildren();
    for (const action of model.actions) {
      const button = el('button', 'plan-action', action.label);
      button.type = 'button';
      button.disabled = !action.enabled;
      actions.append(button);
    }

    readingColumn.replaceChildren();
    renderHeadings(body);
    if (body !== null) return;
    if (failedRequestKey === requestKey()) {
      readingColumn.append(el('p', 'plan-loading', 'This plan revision could not be loaded'));
      return;
    }
    readingColumn.append(el('p', 'plan-loading', 'Loading plan'));
    requestSelectedBody();
  }

  function show(id: string) {
    sessionId = id;
    root.hidden = false;
    lastRequestKey = '';
    failedRequestKey = '';
    render();
  }

  function hide() {
    root.hidden = true;
  }

  function update(next: PlanFaceUpdate) {
    if (next.state) state = next.state;
    if (typeof next.isConnected === 'boolean') {
      const hasReconnected = next.isConnected && !isConnected;
      isConnected = next.isConnected;
      if (hasReconnected) {
        lastRequestKey = '';
        failedRequestKey = '';
      }
    }
    if (next.requestFailed) failedRequestKey = lastRequestKey;
    if (next.response) {
      state = { reviews: next.response.reviews };
      const body = next.response.body;
      if (!body) failedRequestKey = lastRequestKey;
      if (body) {
        cachePlanBody(next.response.id, body);
        selectedAgentId = body.agentId;
        selectedRevision = body.revision;
        lastRequestKey = '';
        failedRequestKey = '';
      }
    }
    if (!root.hidden) render();
  }

  return { el: root, show, hide, update };
}
