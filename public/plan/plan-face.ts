import { PLAN_COMMENT_MAX_CHARS, PLAN_DRAFT_REVISION, PLAN_FEEDBACK_MAX_CHARS } from '#shared/contracts/plan-review.ts';
import type {
  PlanDecisionKind,
  PlanDecisionRequest,
  PlanDraftPush,
  PlanResponseFrame,
  PlanReviewState,
  PlanRevisionBody,
  PlanSectionComment,
} from '#shared/contracts/plan-review.ts';
import { el } from '../dom-helpers.ts';
import { diffPlanBodies } from './plan-diff-core.ts';
import { parsePlanMarkdown, splitPlanSections } from './plan-markdown-core.ts';
import type { PlanSection } from './plan-markdown-core.ts';
import { renderPlanBlocks, renderPlanDiff, renderPlanSections } from './plan-render.ts';
import { createPlanViewModel, openRevisionFor, planLimitRefusal, previousRevisionFor } from './plan-view-core.ts';
import type { PlanActionKind, PlanDecisionExtras } from './plan-view-core.ts';

export type PlanResponse = PlanResponseFrame;

export interface PlanFaceUpdate {
  state?: PlanReviewState;
  response?: PlanResponse;
  draft?: PlanDraftPush;
  isConnected?: boolean;
  requestFailed?: boolean;
  decisionRefused?: boolean;
}

export interface PlanCommentRequest {
  title: string;
  value: string;
  maxChars: number;
}

export interface PlanFaceDeps {
  requestPlan: (id: string, agentId: string | null, revision?: number) => boolean;
  requestDraft: (id: string, agentId: string | null) => boolean;
  showTerminal: () => void;
  sendDecision: (id: string, request: PlanDecisionRequest) => boolean;
  promptFeedback: (request: PlanCommentRequest, onSubmit: (text: string) => void) => void;
  reportProblem: (message: string) => void;
}

interface DecisionTarget {
  agentId: string | null;
  revision: number | null;
}

interface CommentTarget {
  bucketKey: string;
  sectionSlot: string;
}

type PlanRequestKind = 'selection' | 'diff-base' | 'draft';

interface PlanRequestTarget {
  kind: PlanRequestKind;
  agentId: string | null;
  revision: number | null;
}

interface SentComments {
  bucketKey: string;
  agentId: string | null;
  revision: number;
}

const MAX_CACHED_BODIES_PER_SESSION = 12;
const MAX_PENDING_REQUESTS = 8;
const WHOLE_PLAN_SECTION_KEY = '';
const bodyCacheBySession = new Map<string, Map<string, string>>();

function bodyKey(agentId: string | null, revision: number) {
  return JSON.stringify([agentId, revision]);
}

function sectionKey(section: PlanSection) {
  return section.id ?? WHOLE_PLAN_SECTION_KEY;
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
  const diffToggle = el('button', 'plan-head-toggle plan-diff-toggle', 'Diff');
  diffToggle.type = 'button';
  const draftChip = el('button', 'plan-head-toggle plan-draft-chip', 'Draft updated');
  draftChip.type = 'button';
  const readButton = el('button', 'plan-terminal-button plan-read-button', 'Read plan');
  readButton.type = 'button';
  const terminalButton = el('button', 'plan-terminal-button', 'Terminal');
  terminalButton.type = 'button';
  terminalButton.addEventListener('click', deps.showTerminal);
  head.append(tabs, revisionPicker, diffToggle, draftChip, readButton, terminalButton);

  const narrowHeadingPicker = el('select', 'plan-heading-picker');
  narrowHeadingPicker.setAttribute('aria-label', 'Plan section');
  const bodyLayout = el('div', 'plan-body-layout');
  const headingRail = el('nav', 'plan-heading-rail');
  headingRail.setAttribute('aria-label', 'Plan sections');
  const readingColumn = el('article', 'plan-reading-column');
  bodyLayout.append(headingRail, readingColumn);

  const editor = el('textarea', 'plan-editor');
  editor.setAttribute('aria-label', 'Plan markdown');
  editor.spellcheck = false;

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
  let diffRequestKey = '';
  let draftRequestKey = '';
  let isDecisionInFlight = false;
  let isEditing = false;
  let isDiffShown = false;
  let isDraftShown = false;
  let draftBody: string | null = null;
  let currentSections: PlanSection[] = [];
  let problem: string | null = null;
  let sentComments: SentComments | null = null;
  const draftChangedAtBySessionAgent = new Map<string, number>();
  const commentsByRevision = new Map<string, Map<string, string>>();
  const pendingRequestsByTarget = new Map<string, PlanRequestTarget>();

  function scrollToHeading(id: string) {
    const heading = readingColumn.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  narrowHeadingPicker.addEventListener('change', () => scrollToHeading(narrowHeadingPicker.value));

  function leaveTransientViews() {
    isEditing = false;
    isDraftShown = false;
    draftBody = null;
  }

  function noteProblem(message: string) {
    problem = message;
    deps.reportProblem(message);
    render();
  }

  revisionPicker.addEventListener('change', () => {
    selectedRevision = Number(revisionPicker.value) || null;
    problem = null;
    leaveTransientViews();
    render();
  });

  function requestKeyFor(agentId: string | null, revision: number | null) {
    return `${sessionId ?? ''}:${agentId ?? 'main'}:${revision ?? 'latest'}`;
  }

  function requestKey() {
    return requestKeyFor(selectedAgentId, selectedRevision);
  }

  function commentsKeyFor(id: string | null, agentId: string | null, revision: number | null) {
    return `${id ?? ''}:${bodyKey(agentId, revision ?? 0)}`;
  }

  function selectedCommentsKey() {
    return commentsKeyFor(sessionId, selectedAgentId, selectedRevision);
  }

  function storedComments() {
    return commentsByRevision.get(selectedCommentsKey()) ?? null;
  }

  function pendingCommentCount() {
    return storedComments()?.size ?? 0;
  }

  function orderedComments(bucketKey: string): PlanSectionComment[] {
    const stored = commentsByRevision.get(bucketKey);
    if (!stored) return [];
    const ordered: PlanSectionComment[] = [];
    for (const section of currentSections) {
      const comment = stored.get(sectionKey(section));
      if (comment) ordered.push({ heading: section.heading, comment });
    }
    return ordered;
  }

  function noteComment(target: CommentTarget, comment: string) {
    const text = comment.trim();
    const stored = commentsByRevision.get(target.bucketKey) ?? new Map<string, string>();
    commentsByRevision.set(target.bucketKey, stored);
    if (text.length === 0) stored.delete(target.sectionSlot);
    if (text.length > 0) stored.set(target.sectionSlot, text);
    if (stored.size === 0) commentsByRevision.delete(target.bucketKey);
    render();
  }

  function commentOn(section: PlanSection) {
    const target: CommentTarget = { bucketKey: selectedCommentsKey(), sectionSlot: sectionKey(section) };
    const title = section.heading === null ? 'Comment on the plan' : `Comment on "${section.heading}"`;
    const value = commentsByRevision.get(target.bucketKey)?.get(target.sectionSlot) ?? '';
    deps.promptFeedback({ title, value, maxChars: PLAN_COMMENT_MAX_CHARS }, (comment) => noteComment(target, comment));
  }

  function submitDecision(decision: PlanDecisionKind, target: DecisionTarget, extras: PlanDecisionExtras = {}) {
    if (!sessionId || target.revision === null || isDecisionInFlight) return false;
    const refusal = planLimitRefusal(extras);
    if (refusal !== null) {
      noteProblem(refusal);
      return false;
    }
    const request: PlanDecisionRequest = { agentId: target.agentId, revision: target.revision, decision, ...extras };
    if (!deps.sendDecision(sessionId, request)) return false;
    problem = null;
    isDecisionInFlight = true;
    render();
    return true;
  }

  function editedPlanFor(readRevision: DecisionTarget): PlanDecisionExtras {
    if (!isEditing) return {};
    const edited = editor.value;
    if (edited === bodyFromCache(sessionId, readRevision.agentId, readRevision.revision)) return {};
    return { plan: edited };
  }

  function sendFeedback(readRevision: DecisionTarget) {
    const bucketKey = commentsKeyFor(sessionId, readRevision.agentId, readRevision.revision);
    const comments = orderedComments(bucketKey);
    deps.promptFeedback({ title: 'Send feedback', value: '', maxChars: PLAN_FEEDBACK_MAX_CHARS }, (feedback) => {
      const isSent = submitDecision('revise', readRevision, { feedback, ...(comments.length > 0 ? { comments } : {}) });
      if (!isSent || readRevision.revision === null) return;
      sentComments = { bucketKey, agentId: readRevision.agentId, revision: readRevision.revision };
      render();
    });
  }

  function actOn(kind: PlanActionKind) {
    const readRevision: DecisionTarget = { agentId: selectedAgentId, revision: selectedRevision };
    if (kind === 'edit') {
      isEditing = true;
      isDiffShown = false;
      isDraftShown = false;
      problem = null;
      editor.value = bodyFromCache(sessionId, selectedAgentId, selectedRevision) ?? '';
      render();
      return;
    }
    if (kind === 'revise') {
      sendFeedback(readRevision);
      return;
    }
    submitDecision(kind, readRevision, editedPlanFor(readRevision));
  }

  function pendingTargetKey(target: PlanRequestTarget) {
    return `${target.kind}:${requestKeyFor(target.agentId, target.revision)}`;
  }

  function notePendingRequest(target: PlanRequestTarget) {
    pendingRequestsByTarget.set(pendingTargetKey(target), target);
    while (pendingRequestsByTarget.size > MAX_PENDING_REQUESTS) {
      const oldestKey = pendingRequestsByTarget.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      pendingRequestsByTarget.delete(oldestKey);
    }
  }

  function explainsBody(target: PlanRequestTarget, body: PlanRevisionBody) {
    if (target.agentId !== body.agentId) return false;
    if (target.kind === 'draft') return body.revision === PLAN_DRAFT_REVISION;
    if (body.revision === PLAN_DRAFT_REVISION) return false;
    return target.revision === null || target.revision === body.revision;
  }

  function takePendingRequest(body: PlanRevisionBody): PlanRequestTarget | null {
    for (const [key, target] of pendingRequestsByTarget) {
      if (!explainsBody(target, body)) continue;
      pendingRequestsByTarget.delete(key);
      return target;
    }
    return null;
  }

  function takePendingDraftRequest(): PlanRequestTarget | null {
    for (const [key, target] of pendingRequestsByTarget) {
      if (target.kind !== 'draft') continue;
      pendingRequestsByTarget.delete(key);
      return target;
    }
    return null;
  }

  function takeSolePendingRequest(): PlanRequestTarget | null {
    if (pendingRequestsByTarget.size !== 1) return null;
    const only = pendingRequestsByTarget.entries().next().value;
    if (!only) return null;
    pendingRequestsByTarget.delete(only[0]);
    return only[1];
  }

  function requestSelectedBody() {
    if (!sessionId) return;
    const key = requestKey();
    if (lastRequestKey === key) return;
    if (!deps.requestPlan(sessionId, selectedAgentId, selectedRevision ?? undefined)) return;
    lastRequestKey = key;
    notePendingRequest({ kind: 'selection', agentId: selectedAgentId, revision: selectedRevision });
  }

  function refreshReviewIndex() {
    if (root.hidden) return;
    requestSelectedBody();
  }

  function diffBaseRevision() {
    return previousRevisionFor(state, selectedAgentId, selectedRevision);
  }

  function requestDiffBase(revision: number) {
    if (!sessionId) return;
    const key = requestKeyFor(selectedAgentId, revision);
    if (diffRequestKey === key) return;
    if (!deps.requestPlan(sessionId, selectedAgentId, revision)) return;
    diffRequestKey = key;
    notePendingRequest({ kind: 'diff-base', agentId: selectedAgentId, revision });
  }

  function requestDraftBody() {
    if (!sessionId) return;
    const key = `${sessionId}:${selectedAgentId ?? 'main'}`;
    if (draftRequestKey === key) return;
    if (!deps.requestDraft(sessionId, selectedAgentId)) return;
    draftRequestKey = key;
    notePendingRequest({ kind: 'draft', agentId: selectedAgentId, revision: null });
  }

  function draftNoticeKey(id: string | null, agentId: string | null) {
    return `${id ?? ''}:${agentId ?? ''}`;
  }

  function selectedReceivedAt() {
    const review = state.reviews.find((entry) => entry.agentId === selectedAgentId);
    return review?.revisions.find((entry) => entry.revision === selectedRevision)?.receivedAt ?? 0;
  }

  function isDraftNewer() {
    const changedAt = draftChangedAtBySessionAgent.get(draftNoticeKey(sessionId, selectedAgentId));
    if (changedAt === undefined) return false;
    return changedAt > selectedReceivedAt();
  }

  function toggleDraft() {
    if (isDraftShown) {
      leaveTransientViews();
      render();
      return;
    }
    isEditing = false;
    isDiffShown = false;
    requestDraftBody();
    render();
  }

  function toggleDiff() {
    leaveTransientViews();
    isDiffShown = !isDiffShown;
    render();
  }

  diffToggle.addEventListener('click', toggleDiff);
  draftChip.addEventListener('click', toggleDraft);
  readButton.addEventListener('click', () => {
    isEditing = false;
    render();
  });

  function renderHeadingRail(sections: readonly PlanSection[]) {
    headingRail.replaceChildren();
    narrowHeadingPicker.replaceChildren();
    for (const section of sections) {
      if (section.heading === null || section.id === null) continue;
      const headingId = section.id;
      const button = el('button', 'plan-heading-link', section.heading);
      button.type = 'button';
      button.dataset.level = String(section.level);
      button.addEventListener('click', () => scrollToHeading(headingId));
      headingRail.append(button);
      const option = el('option', null, section.heading);
      option.value = headingId;
      narrowHeadingPicker.append(option);
    }
  }

  function renderDiffColumn(body: string) {
    const baseRevision = diffBaseRevision();
    if (baseRevision === null) {
      readingColumn.append(el('p', 'plan-loading', 'This is the first revision, so there is nothing to diff'));
      return;
    }
    const baseBody = bodyFromCache(sessionId, selectedAgentId, baseRevision);
    if (baseBody === null) {
      readingColumn.append(el('p', 'plan-loading', 'Loading the previous revision'));
      requestDiffBase(baseRevision);
      return;
    }
    const diff = diffPlanBodies(baseBody, body);
    if (diff.isTooLarge) {
      readingColumn.append(el('p', 'plan-loading', 'This diff is too large to show, so the newer revision stands alone'));
      readingColumn.append(renderPlanBlocks(parsePlanMarkdown(body)));
      return;
    }
    readingColumn.append(renderPlanDiff(diff));
  }

  function renderColumn(body: string | null) {
    readingColumn.replaceChildren();
    if (isEditing) {
      renderHeadingRail(currentSections);
      readingColumn.append(editor);
      return;
    }
    if (body === null) {
      currentSections = [];
      renderHeadingRail(currentSections);
      if (failedRequestKey === requestKey()) {
        readingColumn.append(el('p', 'plan-loading', 'This plan revision could not be loaded'));
        return;
      }
      readingColumn.append(el('p', 'plan-loading', 'Loading plan'));
      requestSelectedBody();
      return;
    }
    const blocks = parsePlanMarkdown(body);
    currentSections = splitPlanSections(blocks);
    renderHeadingRail(currentSections);
    if (isDiffShown) {
      renderDiffColumn(body);
      return;
    }
    if (isDraftShown) {
      readingColumn.append(renderPlanBlocks(blocks));
      return;
    }
    const stored = storedComments();
    readingColumn.append(renderPlanSections(currentSections, {
      hasComment: (section) => stored?.has(sectionKey(section)) === true,
      onComment: commentOn,
    }));
  }

  function renderTabs(model: ReturnType<typeof createPlanViewModel>) {
    tabs.replaceChildren();
    for (const tab of model.tabs) {
      const button = el('button', 'plan-tab', tab.label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab.selected));
      button.addEventListener('click', () => {
        selectedAgentId = tab.agentId;
        selectedRevision = null;
        problem = null;
        lastRequestKey = '';
        failedRequestKey = '';
        diffRequestKey = '';
        draftRequestKey = '';
        leaveTransientViews();
        render();
      });
      tabs.append(button);
    }
  }

  function render() {
    const selection = createPlanViewModel({ state, selectedAgentId, selectedRevision, body: null, isConnected });
    selectedAgentId = selection.selectedAgentId;
    selectedRevision = selection.selectedRevision;
    const body = isDraftShown ? draftBody : bodyFromCache(sessionId, selectedAgentId, selectedRevision);
    const model = createPlanViewModel({
      state,
      selectedAgentId,
      selectedRevision,
      body,
      isConnected,
      isDecisionInFlight,
      isDraft: isDraftShown,
      pendingCommentCount: pendingCommentCount(),
      problem,
    });

    renderTabs(model);

    revisionPicker.replaceChildren();
    for (const revision of model.revisions) {
      const option = el('option', null, revision.label);
      option.value = String(revision.revision);
      option.selected = revision.selected;
      option.title = new Date(revision.receivedAt).toLocaleString();
      revisionPicker.append(option);
    }
    revisionPicker.hidden = model.revisions.length < 2;
    diffToggle.hidden = model.previousRevision === null;
    diffToggle.setAttribute('aria-pressed', String(isDiffShown));
    draftChip.hidden = !isDraftNewer() && !isDraftShown;
    draftChip.setAttribute('aria-pressed', String(isDraftShown));
    readButton.hidden = !isEditing;
    status.textContent = model.status;

    actions.replaceChildren();
    for (const action of model.actions) {
      const button = el('button', 'plan-action', action.label);
      button.type = 'button';
      button.disabled = !action.enabled;
      button.dataset.decision = action.kind;
      button.addEventListener('click', () => actOn(action.kind));
      actions.append(button);
    }

    renderColumn(body);
  }

  function show(id: string) {
    if (id !== sessionId) {
      isDecisionInFlight = false;
      problem = null;
      pendingRequestsByTarget.clear();
    }
    sessionId = id;
    root.hidden = false;
    lastRequestKey = '';
    failedRequestKey = '';
    render();
    refreshReviewIndex();
  }

  function hide() {
    root.hidden = true;
  }

  function isForSelection(body: PlanRevisionBody, target: PlanRequestTarget) {
    if (target.kind !== 'selection') return false;
    if (body.agentId !== selectedAgentId) return false;
    if (target.revision !== null) return target.revision === selectedRevision;
    return selectedRevision === null || selectedRevision === body.revision;
  }

  function noteRefusedRequest(target: PlanRequestTarget) {
    if (target.kind === 'draft') {
      draftRequestKey = '';
      noteProblem('the draft could not be read, so nothing was shown');
      return;
    }
    if (target.kind === 'diff-base') {
      diffRequestKey = '';
      return;
    }
    failedRequestKey = requestKeyFor(target.agentId, target.revision);
  }

  function confirmSentComments(next: PlanReviewState) {
    if (sentComments === null) return;
    if (openRevisionFor(next, sentComments.agentId) === sentComments.revision) return;
    commentsByRevision.delete(sentComments.bucketKey);
    sentComments = null;
  }

  function adoptResponse(response: PlanResponse) {
    isDecisionInFlight = false;
    state = { reviews: response.reviews };
    confirmSentComments(state);
    const body = response.body;
    if (!body) {
      const refused = takeSolePendingRequest() ?? takePendingDraftRequest();
      if (refused !== null) noteRefusedRequest(refused);
      return;
    }
    const target = takePendingRequest(body);
    if (body.revision === PLAN_DRAFT_REVISION) {
      draftRequestKey = '';
      if (target === null || body.agentId !== selectedAgentId) return;
      draftBody = body.plan;
      isDraftShown = true;
      return;
    }
    cachePlanBody(response.id, body);
    if (target === null || !isForSelection(body, target)) return;
    selectedAgentId = body.agentId;
    selectedRevision = body.revision;
    lastRequestKey = '';
    failedRequestKey = '';
  }

  function adoptState(next: PlanReviewState) {
    const reopenedRevision = openRevisionFor(next, selectedAgentId);
    if (reopenedRevision !== null && reopenedRevision !== openRevisionFor(state, selectedAgentId)) {
      selectedRevision = reopenedRevision;
      leaveTransientViews();
    }
    confirmSentComments(next);
    state = next;
    isDecisionInFlight = false;
  }

  function update(next: PlanFaceUpdate) {
    let hasReconnected = false;
    if (next.state) adoptState(next.state);
    if (next.draft) {
      draftChangedAtBySessionAgent.set(draftNoticeKey(next.draft.id, next.draft.agentId), next.draft.changedAt);
    }
    if (next.decisionRefused) {
      isDecisionInFlight = false;
      sentComments = null;
    }
    if (typeof next.isConnected === 'boolean') {
      hasReconnected = next.isConnected && !isConnected;
      isConnected = next.isConnected;
      if (hasReconnected) {
        lastRequestKey = '';
        failedRequestKey = '';
        diffRequestKey = '';
        draftRequestKey = '';
        isDecisionInFlight = false;
      }
    }
    if (next.requestFailed) failedRequestKey = lastRequestKey;
    if (next.response) adoptResponse(next.response);
    if (!root.hidden) render();
    if (hasReconnected || next.decisionRefused) refreshReviewIndex();
  }

  return { el: root, show, hide, update };
}
