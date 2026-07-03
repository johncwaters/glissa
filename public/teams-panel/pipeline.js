// ── Pipeline rail ─────────────────────────────────────────────
// Stage-node state glyphs on the panel's pipeline rail.

import { STAGE_GLYPH } from './format-core.mjs';

export function setNode(node, state) {
  if (!node) return;
  node.dataset.state = state;
  const glyph = node.querySelector('.stage-glyph');
  if (glyph) glyph.textContent = STAGE_GLYPH[state] || STAGE_GLYPH.idle;
}

export function resetPipeline(stageNodes) { for (const n of stageNodes.values()) { setNode(n, 'idle'); delete n.dataset.round; } }

// Activating a stage implies every earlier stage is done.
export function markStage(stageNodes, stageId, state) {
  if (state !== 'active') { setNode(stageNodes.get(stageId), state); return; }
  const ids = [...stageNodes.keys()];
  const idx = ids.indexOf(stageId);
  ids.forEach((id, i) => {
    const nextState = i < idx ? 'done' : i === idx ? 'active' : 'idle';
    setNode(stageNodes.get(id), nextState);
  });
}

export function settleActive(stageNodes) {
  for (const n of stageNodes.values()) if (n.dataset.state === 'active') setNode(n, 'done');
}

export function stageIndexLabel(refs, stageId) {
  const ids = [...refs.stageNodes.keys()];
  const i = ids.indexOf(stageId);
  return i >= 0 ? `${i + 1} of ${ids.length}` : '';
}

// The stage that runs after `stageId` in pipeline order, or null if it is the last one.
export function nextStageId(refs, stageId) {
  const ids = [...refs.stageNodes.keys()];
  const i = ids.indexOf(stageId);
  return i >= 0 && i + 1 < ids.length ? ids[i + 1] : null;
}
