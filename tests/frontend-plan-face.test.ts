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

  let fitCount = 0;
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
  sessionUi._applyFit = () => { fitCount++; };
  sessionUi._activateTerminalViewer = () => { sessionUi._applyFit?.({ repaintRequested: true }); };
  sessionUi._setBorrowed = (isBorrowed) => { sessionUi.isBorrowed = isBorrowed; };
  sessionUi._showPreferredFace = () => { sessionUi.face = 'plan'; };
  sessionUi._showTerminalFace = () => {
    sessionUi.face = 'terminal';
    sessionUi._applyFit?.({ repaintRequested: true });
  };

  sessionUIs.set('session-a', sessionUi);
  borrowCard(sessionUi, 'session-a', slot, { className: 'focus-centered' });
  assert.equal(sessionUi.isBorrowed, true);
  assert.equal(sessionUi.face, 'plan');
  assert.equal(card.parentElement, slot);
  assert.equal(getBorrowedCardId(), 'session-a');
  assert.equal(fitCount, 1);

  assert.equal(releaseCard(), 'session-a');
  assert.equal(sessionUi.isBorrowed, false);
  assert.equal(sessionUi.face, 'terminal');
  assert.equal(card.parentElement, grid);
  assert.equal(getBorrowedCardId(), null);
  assert.equal(fitCount, 2);
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
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
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
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
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
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
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
    showTerminal: () => {},
    sendDecision: (id, request) => { decisions.push({ id, request: { ...request } }); return true; },
    promptFeedback: () => {},
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
  assert.equal(decisionButton(face.el, 'edit').disabled, true, 'Edit plan waits for M3');

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
    showTerminal: () => {},
    sendDecision: (_id, request) => { decisions.push({ ...request }); return true; },
    promptFeedback: () => {},
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
    showTerminal: () => {},
    sendDecision: (_id, request) => { decisions.push({ ...request }); return true; },
    promptFeedback: (onSubmit) => { feedbackPrompts.push(onSubmit); },
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
    showTerminal: () => {},
    sendDecision: (_id, request) => { decisions.push({ ...request }); return true; },
    promptFeedback: (onSubmit) => { feedbackPrompts.push(onSubmit); },
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
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
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
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
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
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
  });

  face.show('session-selected');
  face.update({
    response: {
      id: 'session-selected',
      reviews: [openMainReview, exploreReview],
      body: { agentId: 'sub-1', revision: 1, plan: '# Explore plan', planFilePath: '/plans/a.md', receivedAt: 30 },
    },
  });
  const requestsAfterBody = requests.length;

  face.hide();
  face.show('session-selected');
  assert.deepEqual(requests.slice(requestsAfterBody), [{ agentId: 'sub-1', revision: 1 }]);
  dropPlanBodyCache('session-selected');
});

test('a hidden plan face transfers no plan when the socket reconnects', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    showTerminal: () => {},
    sendDecision: () => true,
    promptFeedback: () => {},
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
