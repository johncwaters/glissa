import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { Terminal } from '@xterm/xterm';
import type { SessionCardElement, SessionUi } from '../public/session-card/card-registry.ts';
import { preferredBorrowedFace } from '../public/session-card/face-core.ts';

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string) {
    this.values.add(value);
  }

  remove(value: string) {
    this.values.delete(value);
  }

  contains(value: string) {
    return this.values.has(value);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  className = '';
  isConnected = true;
  parentElement: FakeElement | null = null;
  textContent = '';

  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] ?? null;
  }

  appendChild(child: FakeElement) {
    if (child.parentElement) {
      const previousIndex = child.parentElement.children.indexOf(child);
      if (previousIndex !== -1) child.parentElement.children.splice(previousIndex, 1);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeElement, next: FakeElement) {
    if (child.parentElement) {
      const previousIndex = child.parentElement.children.indexOf(child);
      if (previousIndex !== -1) child.parentElement.children.splice(previousIndex, 1);
    }
    child.parentElement = this;
    const nextIndex = this.children.indexOf(next);
    if (nextIndex === -1) return this.appendChild(child);
    this.children.splice(nextIndex, 0, child);
    return child;
  }
}

test('the borrowed card swaps to plan and release restores the terminal face through the fit path', async () => {
  const elementsById = new Map<string, FakeElement>();
  elementsById.set('sessions-container', new FakeElement());
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => new FakeElement(),
      getElementById: (id: string) => elementsById.get(id) ?? null,
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });

  const { sessionUIs } = await import('../public/session-card/card-registry.ts');
  const { borrowCard, getBorrowedCardId, releaseCard } = await import('../public/card-host.ts');
  const grid = document.getElementById('sessions-container');
  assert.ok(grid);
  const slot = document.createElement('div');
  const card = document.createElement('div') as SessionCardElement;
  grid.appendChild(card);

  let terminalWiringCount = 0;
  const activeViewerCalls: boolean[] = [];
  const button = document.createElement('button');
  const sessionUi: SessionUi = {
    term: Object.create(null) as Terminal,
    fitAddon: null,
    webglAddon: null,
    needsWebGLReload: false,
    dataWs: null,
    card,
    nameEl: document.createElement('span'),
    elapsedEl: document.createElement('span'),
    path: '',
    stateSince: 0,
    btnOverflow: button,
    overflowMenu: document.createElement('div'),
    termWrap: document.createElement('div'),
    btnDebug: button,
    btnRename: button,
    btnRestart: button,
    btnRestartFresh: button,
    btnResume: button,
    btnTrace: button,
    btnPlan: button,
    btnOverflowPlan: button,
    btnRemove: button,
    debugOverlay: null,
    debugOpen: false,
    abortController: new AbortController(),
    currentState: 'WAITING',
    face: 'terminal',
    isBorrowed: false,
    hasPlan: true,
    pendingPromptKind: 'plan',
    planReviewState: { reviews: [] },
    planFace: {
      el: document.createElement('section'),
      show: () => {},
      hide: () => {},
      update: () => {},
    },
  };
  sessionUi._setActiveViewer = (isActive) => { activeViewerCalls.push(isActive); };
  sessionUi._ensureTerminalReady = () => { terminalWiringCount++; };
  sessionUi._setBorrowed = (isBorrowed) => { sessionUi.isBorrowed = isBorrowed; };
  sessionUi._showPreferredFace = () => { sessionUi.face = 'plan'; };
  sessionUi._showTerminalFace = () => {
    sessionUi.face = 'terminal';
  };

  sessionUIs.set('session-a', sessionUi);
  borrowCard(sessionUi, 'session-a', slot, { className: 'focus-centered' });
  assert.equal(sessionUi.isBorrowed, true);
  assert.equal(sessionUi.face, 'plan');
  assert.equal(card.parentElement, slot);
  assert.equal(getBorrowedCardId(), 'session-a');
  assert.equal(terminalWiringCount, 1);
  assert.deepEqual(activeViewerCalls, []);

  assert.equal(releaseCard(), 'session-a');
  assert.equal(sessionUi.isBorrowed, false);
  assert.equal(sessionUi.face, 'terminal');
  assert.equal(card.parentElement, grid);
  assert.equal(getBorrowedCardId(), null);
  assert.equal(terminalWiringCount, 1);
  assert.deepEqual(activeViewerCalls, [false]);
  sessionUIs.clear();
});

test('the preferred borrowed face follows plan attention or an open review', () => {
  assert.equal(preferredBorrowedFace({ hasPlan: true, pendingPromptKind: 'plan', hasOpenReview: false }), 'plan');
  assert.equal(preferredBorrowedFace({ hasPlan: true, pendingPromptKind: null, hasOpenReview: true }), 'plan');
  assert.equal(preferredBorrowedFace({ hasPlan: false, pendingPromptKind: 'plan', hasOpenReview: true }), 'terminal');
});

test('a plan summary landing after the plan prompt re-runs the one borrowed face decision', () => {
  assert.equal(preferredBorrowedFace({ hasPlan: false, pendingPromptKind: 'plan', hasOpenReview: false }), 'terminal');
  assert.equal(preferredBorrowedFace({ hasPlan: true, pendingPromptKind: 'plan', hasOpenReview: false }), 'plan');

  const lifecycleSource = fs.readFileSync(new URL('../public/session-card/lifecycle.ts', import.meta.url), 'utf8');
  const policyCalls = lifecycleSource.match(/preferredBorrowedFace\(/g) ?? [];
  assert.equal(policyCalls.length, 1, 'the borrowed face policy is consulted from one place');
  assert.match(lifecycleSource, /export function applySessionPlanChanged[\s\S]*?showPlanFaceWhenPreferred\(message\.id\)/);
  assert.match(lifecycleSource, /export function setSessionPrompt[\s\S]*?showPlanFaceWhenPreferred\(sessionId\)/);
  assert.match(lifecycleSource, /export function setSessionHasPlan[\s\S]*?showPlanFaceWhenPreferred\(sessionId\)/);
});

class PlanFaceElement {
  children: PlanFaceElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  private readonly listenersByType = new Map<string, (() => void)[]>();
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  selected = false;
  type = '';
  title = '';
  value = '';
  tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listenersByType.get(type) ?? [];
    listeners.push(listener);
    this.listenersByType.set(type, listeners);
  }

  fire(type: string) {
    for (const listener of this.listenersByType.get(type) ?? []) listener();
  }

  append(...nodes: PlanFaceElement[]) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: PlanFaceElement[]) {
    this.children = [...nodes];
  }

  querySelector() {
    return null;
  }
}

interface TextBearingNode {
  readonly textContent: string | null;
  readonly children: ArrayLike<TextBearingNode>;
}

function planFaceTexts(root: TextBearingNode): string[] {
  const nested = Array.from(root.children).flatMap(planFaceTexts);
  return [root.textContent ?? '', ...nested].filter((text) => text.length > 0);
}

function installPlanFaceDocument() {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => new PlanFaceElement(tag),
      createTextNode: (text: string) => Object.assign(new PlanFaceElement('#text'), { textContent: text }),
    },
  });
}

const exploreReview = {
  agentId: 'sub-1',
  agentType: 'Explore',
  revisions: [{ revision: 1, receivedAt: 30, chars: 14, title: 'Explore plan' }],
  state: 'closed' as const,
  openRevision: null,
  approvedRevision: 1,
  lastDecision: null,
};

const openMainReview = {
  agentId: null,
  agentType: null,
  revisions: [{ revision: 2, receivedAt: 40, chars: 10, title: 'Ship it' }],
  state: 'open' as const,
  openRevision: { revision: 2, since: 40 },
  approvedRevision: null,
  lastDecision: null,
};

function planFaceButtons(root: unknown): PlanFaceElement[] {
  if (!(root instanceof PlanFaceElement)) return [];
  const nested = root.children.flatMap(planFaceButtons);
  return root.tagName === 'button' ? [root, ...nested] : nested;
}

function planFaceElements(root: unknown): PlanFaceElement[] {
  if (!(root instanceof PlanFaceElement)) return [];
  return [root, ...root.children.flatMap(planFaceElements)];
}

function byClass(root: unknown, className: string): PlanFaceElement[] {
  return planFaceElements(root).filter((node) => node.className.split(/\s+/).includes(className));
}

function onlyByClass(root: unknown, className: string): PlanFaceElement {
  const found = byClass(root, className);
  if (found.length !== 1) throw new Error(`expected one .${className}, found ${found.length}`);
  return found[0];
}

function decisionButton(root: unknown, kind: string): PlanFaceElement {
  const found = planFaceButtons(root).find((button) => button.dataset.decision === kind);
  if (!found) throw new Error(`no ${kind} action button`);
  return found;
}

test('a shown plan face asks for the review index, then for the one body the index names', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { id: string; agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (id, agentId, revision) => { requests.push({ id, agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
    reportProblem: () => {},
  });

  face.show('session-index');
  assert.deepEqual(requests, [{ id: 'session-index', agentId: null, revision: undefined }]);

  face.update({ response: { id: 'session-index', reviews: [exploreReview], body: null } });
  assert.deepEqual(requests.at(-1), { id: 'session-index', agentId: 'sub-1', revision: 1 });

  face.update({
    response: {
      id: 'session-index',
      reviews: [exploreReview],
      body: { agentId: 'sub-1', revision: 1, plan: '# Explore plan', planFilePath: '/plans/a.md', receivedAt: 30 },
    },
  });
  assert.equal(requests.length, 2, 'a body already in hand is never asked for again');
  dropPlanBodyCache('session-index');
});

test('a reply with no body stops the request loop and says the revision could not be loaded', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: string[] = [];
  const face = createPlanFace({
    requestPlan: (id, agentId, revision) => { requests.push(`${id}:${agentId}:${revision}`); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
    reportProblem: () => {},
  });

  face.show('session-null-body');
  face.update({ response: { id: 'session-null-body', reviews: [exploreReview], body: null } });
  const requestsAfterFirstMiss = requests.length;
  face.update({ response: { id: 'session-null-body', reviews: [exploreReview], body: null } });

  assert.equal(requests.length, requestsAfterFirstMiss, 'a second empty reply never re-asks for the same revision');
  assert.ok(planFaceTexts(face.el).includes('This plan revision could not be loaded'));
  dropPlanBodyCache('session-null-body');
});

test('an error reply and a dropped send both leave the face able to ask again', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: string[] = [];
  const sending = { succeeds: false };
  const face = createPlanFace({
    requestPlan: (id, agentId, revision) => {
      if (!sending.succeeds) return false;
      requests.push(`${id}:${agentId}:${revision}`);
      return true;
    },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
    reportProblem: () => {},
  });

  face.show('session-offline');
  assert.deepEqual(requests, [], 'a dropped send never reaches the server');

  face.update({ isConnected: false });
  assert.deepEqual(requests, [], 'a disconnected face never asks');

  sending.succeeds = true;
  face.update({ isConnected: true });
  assert.deepEqual(requests, ['session-offline:null:undefined'], 'reconnecting retries the request the socket dropped');

  face.update({ requestFailed: true });
  assert.ok(planFaceTexts(face.el).includes('This plan revision could not be loaded'));
  dropPlanBodyCache('session-offline');
});

test('an approve click sends one decision, then every action disables until the review changes', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const decisions: { id: string; request: Record<string, unknown> }[] = [];
  const face = createPlanFace({
    requestPlan: () => true,
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: (id, request) => { decisions.push({ id, request: { ...request } }); return true; },
    promptFeedback: () => {},
    reportProblem: () => {},
  });

  face.show('session-approve');
  face.update({
    response: {
      id: 'session-approve',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(decisionButton(face.el, 'approve').disabled, false);
  assert.equal(decisionButton(face.el, 'edit').disabled, false, 'the editor opens from the same guard as Approve');

  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(decisions, [{ id: 'session-approve', request: { agentId: null, revision: 2, decision: 'approve' } }]);
  for (const kind of ['approve', 'approve-accept-edits', 'revise', 'terminal']) {
    assert.equal(decisionButton(face.el, kind).disabled, true, `${kind} is disabled while the decision is in flight`);
  }
  assert.ok(planFaceTexts(face.el).some((text) => text.includes('sending your decision')));
  assert.deepEqual(
    planFaceButtons(face.el).filter((button) => button.dataset.decision).map((button) => button.textContent),
    ['Approve', 'Approve and accept edits', 'Send feedback', 'Answer in terminal', 'Edit plan'],
    'labels never change while a decision is in flight',
  );

  decisionButton(face.el, 'approve').fire('click');
  assert.equal(decisions.length, 1, 'a second click while one decision is in flight sends nothing');

  face.update({ state: { reviews: [{ ...openMainReview, state: 'decided', openRevision: null, lastDecision: 'approve' }] } });
  assert.ok(planFaceTexts(face.el).some((text) => text.includes('Approved')));
  dropPlanBodyCache('session-approve');
});

test('a revision that reopens the review moves the face onto it, so no decision names the revision it replaced', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const decisions: Record<string, unknown>[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: (_id, request) => { decisions.push({ ...request }); return true; },
    promptFeedback: () => {},
    reportProblem: () => {},
  });

  face.show('session-reopen');
  face.update({
    response: {
      id: 'session-reopen',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(decisionButton(face.el, 'approve').disabled, false);

  const reopened = {
    ...openMainReview,
    revisions: [...openMainReview.revisions, { revision: 3, receivedAt: 50, chars: 12, title: 'Ship it again' }],
    openRevision: { revision: 3, since: 50 },
  };
  face.update({ state: { reviews: [reopened] } });
  assert.deepEqual(requests.at(-1), { agentId: null, revision: 3 }, 'the face asks for the revision that reopened the review');
  assert.equal(decisionButton(face.el, 'approve').disabled, true, 'nothing is decidable until those bytes are on screen');

  face.update({
    response: {
      id: 'session-reopen',
      reviews: [reopened],
      body: { agentId: null, revision: 3, plan: '# Ship it again', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(decisions, [{ agentId: null, revision: 3, decision: 'approve' }]);
  dropPlanBodyCache('session-reopen');
});

test('Send feedback asks for text through the modal dep and sends it with the revise decision', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const decisions: Record<string, unknown>[] = [];
  const feedbackPrompts: ((feedback: string) => void)[] = [];
  const face = createPlanFace({
    requestPlan: () => true,
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: (_id, request) => { decisions.push({ ...request }); return true; },
    promptFeedback: (_request, onSubmit) => { feedbackPrompts.push(onSubmit); },
    reportProblem: () => {},
  });

  face.show('session-feedback');
  face.update({
    response: {
      id: 'session-feedback',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  decisionButton(face.el, 'revise').fire('click');
  assert.equal(decisions.length, 0, 'nothing is sent until the modal comes back');
  assert.equal(feedbackPrompts.length, 1, 'the face asked for feedback through the dep');
  feedbackPrompts[0]('step 2 must print the file');
  assert.deepEqual(decisions, [{ agentId: null, revision: 2, decision: 'revise', feedback: 'step 2 must print the file' }]);
  dropPlanBodyCache('session-feedback');
});

test('feedback names the revision whose button opened the modal, never one that arrived while it was open', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const decisions: Record<string, unknown>[] = [];
  const feedbackPrompts: ((feedback: string) => void)[] = [];
  const face = createPlanFace({
    requestPlan: () => true,
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: (_id, request) => { decisions.push({ ...request }); return true; },
    promptFeedback: (_request, onSubmit) => { feedbackPrompts.push(onSubmit); },
    reportProblem: () => {},
  });

  face.show('session-modal-race');
  face.update({
    response: {
      id: 'session-modal-race',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  decisionButton(face.el, 'revise').fire('click');

  face.update({
    state: {
      reviews: [{
        ...openMainReview,
        revisions: [...openMainReview.revisions, { revision: 3, receivedAt: 50, chars: 12, title: 'Ship it again' }],
        openRevision: { revision: 3, since: 50 },
      }],
    },
  });
  feedbackPrompts[0]('step 2 must print the file');
  assert.deepEqual(
    decisions,
    [{ agentId: null, revision: 2, decision: 'revise', feedback: 'step 2 must print the file' }],
    'the server refuses the read revision rather than accepting feedback on bytes nobody saw',
  );
  dropPlanBodyCache('session-modal-race');
});

test('a refused decision re-enables the actions and pulls the review index again', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
    reportProblem: () => {},
  });

  face.show('session-refused');
  face.update({
    response: {
      id: 'session-refused',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  decisionButton(face.el, 'approve').fire('click');
  const requestsBeforeRefusal = requests.length;

  face.update({ decisionRefused: true });
  assert.equal(decisionButton(face.el, 'approve').disabled, false, 'a refusal hands the actions back');
  assert.deepEqual(requests.slice(requestsBeforeRefusal), [{ agentId: null, revision: 2 }]);
  dropPlanBodyCache('session-refused');
});

test('showing the face and reconnecting both pull the review index, which backpressure may have dropped', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
    reportProblem: () => {},
  });

  face.show('session-repair');
  assert.deepEqual(requests, [{ agentId: null, revision: undefined }], 'one request covers both the body and the index');

  face.update({
    response: {
      id: 'session-repair',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  const requestsAfterBody = requests.length;

  face.show('session-repair');
  assert.deepEqual(requests.slice(requestsAfterBody), [{ agentId: null, revision: 2 }], 'a cached body still pulls the index');

  face.update({ isConnected: false });
  face.update({ isConnected: true });
  assert.deepEqual(requests.slice(requestsAfterBody + 1), [{ agentId: null, revision: 2 }], 'a reconnect pulls the index');
  dropPlanBodyCache('session-repair');
});

test('a repair pull carries the selected review, so showing the face again never snaps back to the main plan', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
    reportProblem: () => {},
  });

  face.show('session-selected');
  face.update({
    response: {
      id: 'session-selected',
      reviews: [openMainReview, exploreReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  byClass(face.el, 'plan-tab')[1].fire('click');
  const requestsAfterSelect = requests.length;

  face.hide();
  face.show('session-selected');
  assert.deepEqual(requests.slice(requestsAfterSelect), [{ agentId: 'sub-1', revision: 1 }]);
  dropPlanBodyCache('session-selected');
});

test('a hidden plan face transfers no plan when the socket reconnects', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
    reportProblem: () => {},
  });

  face.show('session-offscreen');
  face.update({
    response: {
      id: 'session-offscreen',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  const requestsAfterBody = requests.length;

  face.hide();
  face.update({ isConnected: false });
  face.update({ isConnected: true });
  assert.equal(requests.length, requestsAfterBody, 'a card nobody is looking at costs one reconnect nothing');

  face.show('session-offscreen');
  assert.deepEqual(requests.slice(requestsAfterBody), [{ agentId: null, revision: 2 }], 'showing it pulls the index the reconnect skipped');
  dropPlanBodyCache('session-offscreen');
});

test('a plan deep link that cannot open the plan says so', () => {
  const appSource = fs.readFileSync(new URL('../public/app.ts', import.meta.url), 'utf8');
  const planHashSource = appSource.slice(
    appSource.indexOf('function activatePlanHash'),
    appSource.indexOf('function activateLocationHash'),
  );

  assert.match(planHashSource, /if \(!showPhonePlan\(sessionId\)\) showErrorToast\('No plan is stored for this session yet'\)/);
  assert.match(planHashSource, /if \(!openPlanInFocus\(sessionId\)\) showErrorToast\('No plan is stored for this session yet'\)/);
});

const twoRevisionReview = {
  agentId: null,
  agentType: null,
  revisions: [
    { revision: 1, receivedAt: 40, chars: 10, title: 'Ship it' },
    { revision: 2, receivedAt: 50, chars: 12, title: 'Ship it again' },
  ],
  state: 'open' as const,
  openRevision: { revision: 2, since: 50 },
  approvedRevision: null,
  lastDecision: null,
};

const SECTIONED_PLAN = '# Ship it\n\nthe opening\n\n## Rollout\n\nstage it\n\n## Rollback\n\nown it\n';

interface FacePrompt {
  title: string;
  value: string;
  maxChars: number;
  submit: (text: string) => void;
}

function sectionedFace() {
  installPlanFaceDocument();
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const draftRequests: (string | null)[] = [];
  const decisions: Record<string, unknown>[] = [];
  const prompts: FacePrompt[] = [];
  const problems: string[] = [];
  return {
    requests,
    draftRequests,
    decisions,
    prompts,
    problems,
    deps: {
      requestPlan: (_id: string, agentId: string | null, revision?: number) => {
        requests.push({ agentId, revision });
        return true;
      },
      requestDraft: (_id: string, agentId: string | null) => { draftRequests.push(agentId); return true; },
      showTerminal: () => {},
      sendDecision: (_id: string, request: Record<string, unknown>) => { decisions.push({ ...request }); return true; },
      promptFeedback: (
        { title, value, maxChars }: { title: string; value: string; maxChars: number },
        submit: (text: string) => void,
      ) => {
        prompts.push({ title, value, maxChars, submit });
      },
      reportProblem: (message: string) => { problems.push(message); },
    },
  };
}

test('a comment attaches to the section its affordance sits in, and rides the revise decision in document order', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-comments');
  face.update({
    response: {
      id: 'session-comments',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  const commentButtons = byClass(face.el, 'plan-section-comment');
  assert.equal(commentButtons.length, 3, 'one affordance per section');
  assert.deepEqual(commentButtons.map((button) => button.textContent), ['Comment', 'Comment', 'Comment']);
  assert.deepEqual(commentButtons.map((button) => button.dataset.commented), ['false', 'false', 'false']);

  commentButtons[2].fire('click');
  assert.equal(harness.prompts.at(-1)?.title, 'Comment on "Rollback"');
  harness.prompts.at(-1)?.submit('name the owner');

  byClass(face.el, 'plan-section-comment')[1].fire('click');
  assert.equal(harness.prompts.at(-1)?.title, 'Comment on "Rollout"');
  harness.prompts.at(-1)?.submit('stage it behind the flag');

  assert.ok(planFaceTexts(face.el).some((text) => text.includes('2 comments pending')));
  assert.deepEqual(
    byClass(face.el, 'plan-section-comment').map((button) => button.dataset.commented),
    ['false', 'true', 'true'],
  );

  decisionButton(face.el, 'revise').fire('click');
  assert.equal(harness.prompts.at(-1)?.title, 'Send feedback');
  harness.prompts.at(-1)?.submit('the whole thing is too long');

  assert.deepEqual(harness.decisions, [{
    agentId: null,
    revision: 2,
    decision: 'revise',
    feedback: 'the whole thing is too long',
    comments: [
      { heading: 'Rollout', comment: 'stage it behind the flag' },
      { heading: 'Rollback', comment: 'name the owner' },
    ],
  }]);
  dropPlanBodyCache('session-comments');
});

test('the preamble affordance comments on the plan as a whole, and clearing a comment drops it', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-whole-plan');
  face.update({
    response: {
      id: 'session-whole-plan',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: `a note first\n\n${SECTIONED_PLAN}`, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  byClass(face.el, 'plan-section-comment')[0].fire('click');
  assert.equal(harness.prompts.at(-1)?.title, 'Comment on the plan');
  harness.prompts.at(-1)?.submit('no rollback story anywhere');
  assert.ok(planFaceTexts(face.el).some((text) => text.includes('1 comment pending')));

  byClass(face.el, 'plan-section-comment')[0].fire('click');
  assert.equal(harness.prompts.at(-1)?.value, 'no rollback story anywhere', 'the affordance reopens what was written');
  harness.prompts.at(-1)?.submit('   ');
  assert.equal(planFaceTexts(face.el).some((text) => text.includes('comment pending')), false);

  byClass(face.el, 'plan-section-comment')[0].fire('click');
  harness.prompts.at(-1)?.submit('no rollback story anywhere');
  decisionButton(face.el, 'revise').fire('click');
  harness.prompts.at(-1)?.submit('');
  assert.deepEqual(harness.decisions, [{
    agentId: null,
    revision: 2,
    decision: 'revise',
    feedback: '',
    comments: [{ heading: null, comment: 'no rollback story anywhere' }],
  }]);
  dropPlanBodyCache('session-whole-plan');
});

test('Edit plan swaps the reading column for the markdown, and approving from it sends the edited bytes', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-editor');
  face.update({
    response: {
      id: 'session-editor',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(byClass(face.el, 'plan-editor').length, 0, 'the reading column is what a plan face opens on');

  decisionButton(face.el, 'edit').fire('click');
  const editor = onlyByClass(face.el, 'plan-editor');
  assert.equal(editor.value, SECTIONED_PLAN, 'the editor opens on the markdown of the selected revision');
  assert.equal(byClass(face.el, 'plan-section-comment').length, 0, 'the reading column stepped aside');

  editor.value = `${SECTIONED_PLAN}\n## Rollforward\n\nland it\n`;
  decisionButton(face.el, 'approve-accept-edits').fire('click');
  assert.deepEqual(harness.decisions, [{
    agentId: null,
    revision: 2,
    decision: 'approve-accept-edits',
    plan: `${SECTIONED_PLAN}\n## Rollforward\n\nland it\n`,
  }]);
  dropPlanBodyCache('session-editor');
});

test('leaving the editor sends nothing, and an untouched editor approves the bytes the server holds', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-editor-exit');
  face.update({
    response: {
      id: 'session-editor-exit',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  decisionButton(face.el, 'edit').fire('click');
  const readButton = onlyByClass(face.el, 'plan-read-button');
  assert.equal(readButton.hidden, false);
  assert.equal(readButton.textContent, 'Read plan');
  readButton.fire('click');
  assert.deepEqual(harness.decisions, [], 'leaving the editor decides nothing');
  assert.equal(byClass(face.el, 'plan-editor').length, 0);
  assert.equal(onlyByClass(face.el, 'plan-read-button').hidden, true);

  decisionButton(face.el, 'edit').fire('click');
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(
    harness.decisions,
    [{ agentId: null, revision: 2, decision: 'approve' }],
    'an unedited approve carries no plan, so the server echoes the bytes it received',
  );
  dropPlanBodyCache('session-editor-exit');
});

test('an editor emptied to nothing refuses the decision rather than approving the bytes the server holds', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-editor-empty');
  face.update({
    response: {
      id: 'session-editor-empty',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  decisionButton(face.el, 'edit').fire('click');
  onlyByClass(face.el, 'plan-editor').value = '';
  decisionButton(face.el, 'approve').fire('click');

  assert.deepEqual(harness.decisions, [], 'an emptied editor sends nothing at all');
  assert.deepEqual(harness.problems, ['the edited plan is empty, so nothing was sent']);
  assert.ok(planFaceTexts(face.el).some((text) => text.includes('the edited plan is empty, so nothing was sent')));
  assert.equal(decisionButton(face.el, 'approve').disabled, false, 'the bar stays live for the retry');

  onlyByClass(face.el, 'plan-editor').value = '# Ship it, smaller';
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(
    harness.decisions,
    [{ agentId: null, revision: 2, decision: 'approve', plan: '# Ship it, smaller' }],
    'the retry carries what is on screen',
  );
  dropPlanBodyCache('session-editor-empty');
});

test('a plan over the body cap, a comment over its own cap and a comment count over the wire max are all refused before sending', async () => {
  const harness = sectionedFace();
  const { PLAN_BODY_CAP_BYTES, PLAN_COMMENTS_MAX, PLAN_COMMENT_MAX_CHARS, PLAN_FEEDBACK_MAX_CHARS } = await import('../shared/contracts/plan-review.ts');
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-wire-limits');
  face.update({
    response: {
      id: 'session-wire-limits',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  decisionButton(face.el, 'edit').fire('click');
  onlyByClass(face.el, 'plan-editor').value = 'y'.repeat(PLAN_BODY_CAP_BYTES + 1);
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(harness.decisions, [], 'an oversized plan never reaches the socket');
  assert.deepEqual(harness.problems, ['the edited plan is over the plan size cap, so nothing was sent']);
  onlyByClass(face.el, 'plan-read-button').fire('click');

  byClass(face.el, 'plan-section-comment')[1].fire('click');
  assert.equal(harness.prompts.at(-1)?.maxChars, PLAN_COMMENT_MAX_CHARS, 'the comment sheet caps what can be typed');
  harness.prompts.at(-1)?.submit('z'.repeat(PLAN_COMMENT_MAX_CHARS + 1));
  decisionButton(face.el, 'revise').fire('click');
  assert.equal(harness.prompts.at(-1)?.maxChars, PLAN_FEEDBACK_MAX_CHARS, 'the feedback sheet carries its own cap');
  harness.prompts.at(-1)?.submit('too much');
  assert.deepEqual(harness.decisions, [], 'an oversized comment never reaches the socket');
  assert.equal(harness.problems.at(-1), `a section comment is over ${PLAN_COMMENT_MAX_CHARS} characters, so nothing was sent`);
  assert.ok(
    planFaceTexts(face.el).some((text) => text.includes('1 comment pending')),
    'the refusal keeps the comment the carbon unit typed',
  );

  const { planLimitRefusal } = await import('../public/plan/plan-view-core.ts');
  const tooMany = Array.from({ length: PLAN_COMMENTS_MAX + 1 }, () => ({ heading: 'Rollout', comment: 'stage it' }));
  assert.equal(
    planLimitRefusal({ comments: tooMany }),
    `more than ${PLAN_COMMENTS_MAX} section comments are pending, so nothing was sent`,
  );
  assert.equal(planLimitRefusal({ comments: tooMany.slice(1), plan: '# Ship it', feedback: 'go' }), null);
  dropPlanBodyCache('session-wire-limits');
});

test('the Diff toggle pulls the previous revision once and renders it without moving the selection', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-diff');
  face.update({
    response: {
      id: 'session-diff',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 2, plan: '# Ship it\n\nstage it\n', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });
  const requestsBeforeDiff = harness.requests.length;

  const diffToggle = onlyByClass(face.el, 'plan-diff-toggle');
  assert.equal(diffToggle.textContent, 'Diff');
  assert.equal(diffToggle.hidden, false);
  diffToggle.fire('click');
  assert.deepEqual(harness.requests.slice(requestsBeforeDiff), [{ agentId: null, revision: 1 }]);
  assert.ok(planFaceTexts(face.el).includes('Loading the previous revision'));

  face.update({
    response: {
      id: 'session-diff',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 1, plan: '# Ship it\n\nland it\n', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(diffToggle.attributes['aria-pressed'], 'true');
  assert.deepEqual(
    byClass(face.el, 'plan-diff-line').map((line) => line.className.replace('plan-diff-line ', '')),
    ['plan-diff-unchanged', 'plan-diff-unchanged', 'plan-diff-removed', 'plan-diff-added', 'plan-diff-unchanged'],
  );

  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(
    harness.decisions,
    [{ agentId: null, revision: 2, decision: 'approve' }],
    'the diff base never becomes the revision a decision names',
  );

  diffToggle.fire('click');
  assert.equal(byClass(face.el, 'plan-diff-line').length, 0);
  dropPlanBodyCache('session-diff');
});

test('the first revision offers no diff, because there is nothing behind it', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-first-diff');
  face.update({
    response: {
      id: 'session-first-diff',
      reviews: [exploreReview],
      body: { agentId: 'sub-1', revision: 1, plan: '# Explore plan', planFilePath: '/plans/a.md', receivedAt: 30 },
    },
  });
  assert.equal(onlyByClass(face.el, 'plan-diff-toggle').hidden, true);
  dropPlanBodyCache('session-first-diff');
});

test('the draft chip appears only while a draft is newer than the shown revision, and shows it read-only', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-draft');
  face.update({
    response: {
      id: 'session-draft',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  const chip = onlyByClass(face.el, 'plan-draft-chip');
  assert.equal(chip.textContent, 'Draft updated');
  assert.equal(chip.hidden, true, 'no draft notice means no chip');

  face.update({ draft: { id: 'session-draft', agentId: null, planFilePath: '/plans/a.md', changedAt: 30 } });
  assert.equal(chip.hidden, true, 'a draft older than the revision on screen is not news');

  face.update({ draft: { id: 'session-draft', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  assert.equal(chip.hidden, false);
  assert.deepEqual(harness.draftRequests, [], 'the chip never pulls a body nobody asked for');

  chip.fire('click');
  assert.deepEqual(harness.draftRequests, [null]);

  face.update({
    response: {
      id: 'session-draft',
      reviews: [openMainReview],
      body: { agentId: null, revision: 0, plan: '# Ship it\n\nthe draft', planFilePath: '/plans/a.md', receivedAt: 91 },
    },
  });
  assert.ok(planFaceTexts(face.el).some((text) => text.startsWith('Draft, ')));
  for (const kind of ['approve', 'approve-accept-edits', 'revise', 'terminal', 'edit']) {
    assert.equal(decisionButton(face.el, kind).disabled, true, `${kind} is refused on a draft nobody submitted`);
  }
  assert.equal(chip.attributes['aria-pressed'], 'true');

  chip.fire('click');
  assert.ok(planFaceTexts(face.el).some((text) => text.includes('Revision 1 of 1')));
  assert.equal(decisionButton(face.el, 'approve').disabled, false, 'leaving the draft hands the revision back');
  dropPlanBodyCache('session-draft');
});

test('a draft notice for another session never reaches this face', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-mine');
  face.update({
    response: {
      id: 'session-mine',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  face.update({ draft: { id: 'session-other', agentId: null, planFilePath: '/plans/b.md', changedAt: 900 } });
  assert.equal(onlyByClass(face.el, 'plan-draft-chip').hidden, true);
  dropPlanBodyCache('session-mine');
});

test('a comment files against the revision its modal opened on, even when a newer one arrives first', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-comment-race');
  face.update({
    response: {
      id: 'session-comment-race',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  byClass(face.el, 'plan-section-comment')[2].fire('click');

  const reopened = {
    ...openMainReview,
    revisions: [...openMainReview.revisions, { revision: 3, receivedAt: 50, chars: 12, title: 'Ship it again' }],
    openRevision: { revision: 3, since: 50 },
  };
  face.update({ state: { reviews: [reopened] } });
  harness.prompts.at(-1)?.submit('name the owner');
  assert.equal(
    planFaceTexts(face.el).some((text) => text.includes('comment pending')),
    false,
    'the revision that replaced the one on screen carries no comment nobody wrote against it',
  );

  face.update({
    response: {
      id: 'session-comment-race',
      reviews: [reopened],
      body: { agentId: null, revision: 3, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });
  decisionButton(face.el, 'revise').fire('click');
  harness.prompts.at(-1)?.submit('start again');
  assert.deepEqual(harness.decisions, [{ agentId: null, revision: 3, decision: 'revise', feedback: 'start again' }]);

  const picker = onlyByClass(face.el, 'plan-revision-picker');
  picker.value = '2';
  picker.fire('change');
  assert.ok(planFaceTexts(face.el).some((text) => text.includes('1 comment pending')));
  assert.deepEqual(
    byClass(face.el, 'plan-section-comment').map((button) => button.dataset.commented),
    ['false', 'false', 'true'],
    'the comment waited in the bucket of the revision it was written against',
  );
  dropPlanBodyCache('session-comment-race');
});

test('a revise the socket refused keeps every comment for the retry that follows', async () => {
  const harness = sectionedFace();
  const sending = { succeeds: false };
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace({
    ...harness.deps,
    sendDecision: (id: string, request: Record<string, unknown>) => {
      if (!sending.succeeds) return false;
      return harness.deps.sendDecision(id, request);
    },
  });

  face.show('session-revise-dropped');
  face.update({
    response: {
      id: 'session-revise-dropped',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  byClass(face.el, 'plan-section-comment')[1].fire('click');
  harness.prompts.at(-1)?.submit('stage it behind the flag');

  decisionButton(face.el, 'revise').fire('click');
  harness.prompts.at(-1)?.submit('the whole thing is too long');
  assert.deepEqual(harness.decisions, [], 'a dropped send never reaches the server');
  assert.ok(
    planFaceTexts(face.el).some((text) => text.includes('1 comment pending')),
    'the comments survive a send that never left the tab',
  );

  sending.succeeds = true;
  decisionButton(face.el, 'revise').fire('click');
  harness.prompts.at(-1)?.submit('the whole thing is too long');
  const revise = {
    agentId: null,
    revision: 2,
    decision: 'revise',
    feedback: 'the whole thing is too long',
    comments: [{ heading: 'Rollout', comment: 'stage it behind the flag' }],
  };
  assert.deepEqual(harness.decisions, [revise]);
  assert.ok(
    planFaceTexts(face.el).some((text) => text.includes('1 comment pending')),
    'a send the server has not answered yet is no reason to forget the comment',
  );

  face.update({ decisionRefused: true });
  assert.ok(
    planFaceTexts(face.el).some((text) => text.includes('1 comment pending')),
    'a refused decision leaves the comment where the retry can find it',
  );
  decisionButton(face.el, 'revise').fire('click');
  harness.prompts.at(-1)?.submit('the whole thing is too long');
  assert.deepEqual(harness.decisions, [revise, revise], 'the retry carries the same comment');

  face.update({ state: { reviews: [{ ...openMainReview, state: 'decided' as const, openRevision: null, lastDecision: 'revise' as const }] } });
  assert.equal(
    planFaceTexts(face.el).some((text) => text.includes('comment pending')),
    false,
    'the bucket empties once the review moved off the revision the comment named',
  );
  dropPlanBodyCache('session-revise-dropped');
});

test('a body nobody asked for is cached without moving the selection, and a refusal is charged to the one request in flight', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-unmatched');
  face.update({
    response: {
      id: 'session-unmatched',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 2, plan: '# Ship it\n\nstage it\n', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });
  face.update({
    response: {
      id: 'session-unmatched',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 1, plan: '# Ship it\n\nland it\n', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.ok(
    planFaceTexts(face.el).some((text) => text.includes('Revision 2 of 2')),
    'a revision nobody asked for never becomes the one a decision would name',
  );

  face.update({ draft: { id: 'session-unmatched', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null]);
  face.update({ response: { id: 'session-unmatched', reviews: [twoRevisionReview], body: null } });

  assert.equal(
    planFaceTexts(face.el).some((text) => text.includes('This plan revision could not be loaded')),
    false,
    'a refused draft read never reports the selected revision as unreadable',
  );
  assert.equal(
    harness.problems.at(-1),
    'the draft could not be read, so nothing was shown',
    'a refused draft says so rather than swallowing the click',
  );
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null, null], 'the chip can ask again after a refusal');
  dropPlanBodyCache('session-unmatched');
});

test('a draft refused while another request is in flight still frees the chip, never leaving it dead', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);
  face.show('session-two-pending');
  face.update({
    response: {
      id: 'session-two-pending',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 2, plan: '# Ship it\n\nstage it\n', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });

  const picker = onlyByClass(face.el, 'plan-revision-picker');
  picker.value = '1';
  picker.fire('change');
  face.update({ draft: { id: 'session-two-pending', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null], 'the selection pull and the draft pull are both in flight');

  face.update({ response: { id: 'session-two-pending', reviews: [twoRevisionReview], body: null } });
  assert.equal(harness.problems.at(-1), 'the draft could not be read, so nothing was shown');
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null, null], 'a second request in flight never wedges the chip');
  dropPlanBodyCache('session-two-pending');
});

test('a draft notice that lands before the face is ever shown still raises the chip', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.update({ draft: { id: 'session-draft-early', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  face.show('session-draft-early');
  face.update({
    response: {
      id: 'session-draft-early',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  assert.equal(onlyByClass(face.el, 'plan-draft-chip').hidden, false, 'the notice survived a face nobody had opened yet');
  dropPlanBodyCache('session-draft-early');
});

test('a draft on screen offers no comment affordance, since a draft carries no revision to file one against', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-draft-comment');
  face.update({
    response: {
      id: 'session-draft-comment',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(byClass(face.el, 'plan-section-comment').length, 3);

  face.update({ draft: { id: 'session-draft-comment', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  face.update({
    response: {
      id: 'session-draft-comment',
      reviews: [openMainReview],
      body: { agentId: null, revision: 0, plan: `${SECTIONED_PLAN}\n## Rollforward\n\nland it\n`, planFilePath: '/plans/a.md', receivedAt: 91 },
    },
  });
  assert.ok(planFaceTexts(face.el).some((text) => text.startsWith('Draft, ')));
  assert.equal(byClass(face.el, 'plan-section-comment').length, 0);
  assert.ok(planFaceTexts(face.el).includes('Rollforward'), 'the draft body still reads');

  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.equal(byClass(face.el, 'plan-section-comment').length, 3, 'the revision hands its affordances back');
  dropPlanBodyCache('session-draft-comment');
});

test('a draft answered after the operator moved to another agent is cached, never shown under that agent', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-draft-identity');
  face.update({
    response: {
      id: 'session-draft-identity',
      reviews: [openMainReview, exploreReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  face.update({ draft: { id: 'session-draft-identity', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null]);

  byClass(face.el, 'plan-tab')[1].fire('click');
  face.update({
    response: {
      id: 'session-draft-identity',
      reviews: [openMainReview, exploreReview],
      body: { agentId: null, revision: 0, plan: '# the main draft', planFilePath: '/plans/a.md', receivedAt: 91 },
    },
  });

  assert.equal(
    planFaceTexts(face.el).some((text) => text.includes('the main draft')),
    false,
    'the draft the main review asked for never renders under the subagent review',
  );
  assert.equal(planFaceTexts(face.el).some((text) => text.startsWith('Draft, ')), false);
  dropPlanBodyCache('session-draft-identity');
});

test('a diff base answered after a reopen never drags the face back onto the revision it compared against', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-diff-identity');
  face.update({
    response: {
      id: 'session-diff-identity',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 2, plan: '# Ship it\n\nstage it\n', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });
  onlyByClass(face.el, 'plan-diff-toggle').fire('click');
  assert.deepEqual(harness.requests.at(-1), { agentId: null, revision: 1 });

  const reopened = {
    ...twoRevisionReview,
    revisions: [...twoRevisionReview.revisions, { revision: 3, receivedAt: 60, chars: 12, title: 'Ship it again' }],
    openRevision: { revision: 3, since: 60 },
  };
  face.update({ state: { reviews: [reopened] } });
  face.update({
    response: {
      id: 'session-diff-identity',
      reviews: [reopened],
      body: { agentId: null, revision: 1, plan: '# Ship it\n\nland it\n', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  assert.ok(
    planFaceTexts(face.el).some((text) => text.includes('Revision 3 of 3')),
    'the face stays on the revision that reopened the review',
  );
  dropPlanBodyCache('session-diff-identity');
});
