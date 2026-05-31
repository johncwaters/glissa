// Container-level drag-and-drop for session cards. Owns the five drag-private
// state variables and the module-load-time side effects that wire the container
// and minimizedBar event listeners. setupDragAndDrop is the only export; it is
// called by createSessionCard (lifecycle), whose import of this module is what
// evaluates drag-drop.js and installs those container-level listeners.

import { sendControlMsg } from '../control-ws.js';
import { container, markLocalReorderPending, minimizedBar, sessionUIs } from './card-registry.js';
import { closestCardByCenter } from './geometry-core.mjs';
import { _applyExpandState, isMaximizeActive, toggleMinimize } from './layout.js';

function sendReorder() {
  markLocalReorderPending();
  const gridCards = [...container.querySelectorAll('.session-card')].map(c => c.dataset.id);
  const minCards = [...minimizedBar.querySelectorAll('.session-card')].map(c => c.dataset.id);
  const order = [...gridCards, ...minCards].filter(Boolean);
  sendControlMsg({ type: 'reorder-sessions', order });
}

// ── Container-level drag-and-drop ────────────────────────────

let _dragSource = null;

// Cached card rects for drag operations — avoids layout thrashing on every dragover
let _dragRectCache = null;

function snapshotDragRects() {
  const allCards = [...container.querySelectorAll('.session-card')];
  _dragRectCache = allCards.map(card => ({ card, rect: card.getBoundingClientRect() }));
}

function invalidateDragRects() {
  _dragRectCache = null;
}

function findDropTarget(x, y) {
  if (!_dragRectCache) snapshotDragRects();
  const sourceCard = _dragSource ? _dragSource.card : null;
  return closestCardByCenter(x, y, _dragRectCache, sourceCard, _dropZone);
}

function clearDropIndicators() {
  for (const [, ui] of sessionUIs) {
    ui.card.classList.remove('drop-above', 'drop-below');
  }
}

// Drop-zone placeholder shown at the end of the grid when dragging from minimized bar
const _dropZone = document.createElement('div');
_dropZone.className = 'session-card drop-zone-placeholder';
_dropZone.innerHTML = '<div class="drop-zone-label">Drop here to expand</div>';
let _droppedOnZone = false;

function isFromMinimizedBar() {
  return _dragSource?.card.classList.contains('minimized');
}

function showDropZone() {
  if (!_dropZone.parentNode) {
    container.appendChild(_dropZone);
    invalidateDragRects();
  }
}

function hideDropZone() {
  if (_dropZone.parentNode) {
    _dropZone.remove();
    invalidateDragRects();
  }
}

_dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  clearDropIndicators();
  _dropZone.classList.add('drop-zone-active');
});

_dropZone.addEventListener('dragleave', () => {
  _dropZone.classList.remove('drop-zone-active');
});

_dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  _dropZone.classList.remove('drop-zone-active');
  _droppedOnZone = true;
  clearDropIndicators();
  hideDropZone();
  if (!_dragSource) return;

  const sessionId = _dragSource.card.dataset.id;
  container.appendChild(_dragSource.card);
  _applyExpandState(sessionId, _dragSource);
  sendReorder();
});

let _dragoverRafId = null;

container.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (_dragoverRafId !== null) return;
  const cx = e.clientX, cy = e.clientY;
  _dragoverRafId = requestAnimationFrame(() => {
    _dragoverRafId = null;
    clearDropIndicators();
    if (isFromMinimizedBar()) showDropZone();
    _dropZone.classList.remove('drop-zone-active');
    const { card, before } = findDropTarget(cx, cy);
    if (card) card.classList.add(before ? 'drop-above' : 'drop-below');
  });
});

container.addEventListener('dragleave', (e) => {
  if (!container.contains(e.relatedTarget)) {
    clearDropIndicators();
    hideDropZone();
  }
});

function restoreFromMinimizedBar(target, before) {
  const sessionId = _dragSource.card.dataset.id;

  if (target && target !== _dragSource.card) {
    container.insertBefore(_dragSource.card, before ? target : target.nextSibling);
  } else {
    container.appendChild(_dragSource.card);
  }

  _applyExpandState(sessionId, _dragSource);
}

container.addEventListener('drop', (e) => {
  e.preventDefault();
  clearDropIndicators();
  hideDropZone();
  if (!_dragSource || _droppedOnZone) { _droppedOnZone = false; return; }

  const { card, before } = findDropTarget(e.clientX, e.clientY);

  if (isFromMinimizedBar()) {
    restoreFromMinimizedBar(card, before);
  } else {
    if (!card || card === _dragSource.card) return;
    container.insertBefore(_dragSource.card, before ? card : card.nextSibling);
  }

  sendReorder();
});

export function setupDragAndDrop(card, header, btnMinimize, sessionId) {
  card.draggable = false;
  let didDrag = false;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.session-actions')) return;
    if (isMaximizeActive()) return;
    didDrag = false;
    card.draggable = true;
  });

  header.addEventListener('mouseup', () => {
    if (!didDrag) card.draggable = false;
  });

  btnMinimize.addEventListener('click', () => {
    if (!didDrag) toggleMinimize(sessionId);
  });

  card.addEventListener('dragstart', (e) => {
    didDrag = true;
    _droppedOnZone = false;
    _dragSource = sessionUIs.get(sessionId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sessionId);
    card.classList.add('dragging');
    container.classList.add('drag-active');
    snapshotDragRects();
    if (card.classList.contains('minimized')) showDropZone();
  });

  card.addEventListener('dragend', () => {
    card.draggable = false;
    card.classList.remove('dragging');
    container.classList.remove('drag-active');
    if (_dragoverRafId !== null) {
      cancelAnimationFrame(_dragoverRafId);
      _dragoverRafId = null;
    }
    clearDropIndicators();
    hideDropZone();
    _dragSource = null;
    invalidateDragRects();
  });
}
