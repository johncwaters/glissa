// ── Guide tooltip component ──────────────────────────────────
// Floating tooltip that points at a target element with an arrow.
// Single instance — reused across guide steps.

import { el } from './dom-helpers.js';

// ── State ────────────────────────────────────────────────────

let _overlay = null;
let _tooltip = null;
let _arrow = null;
let _currentTarget = null;
let _callbacks = {};

// ── DOM construction ─────────────────────────────────────────

function ensureDOM() {
  if (_overlay) return;

  _overlay = el('div', 'guide-overlay');
  _tooltip = el('div', 'guide-tooltip');

  const titleEl = el('div', 'guide-title');
  const bodyEl = el('div', 'guide-body');
  const footer = el('div', 'guide-footer');
  const stepCounter = el('span', 'guide-step-counter');
  const actions = el('div', 'guide-actions');
  const btnBack = el('button', 'guide-btn guide-btn-back', 'Back');
  const btnSkip = el('button', 'guide-btn guide-btn-skip', 'Skip');
  const btnNext = el('button', 'guide-btn guide-btn-next', 'Next');

  actions.append(btnBack, btnSkip, btnNext);
  footer.append(stepCounter, actions);
  _tooltip.append(titleEl, bodyEl, footer);

  _arrow = el('div', 'guide-arrow');
  _tooltip.appendChild(_arrow);

  btnNext.addEventListener('click', () => _callbacks.onNext?.());
  btnBack.addEventListener('click', () => _callbacks.onBack?.());
  btnSkip.addEventListener('click', () => _callbacks.onSkip?.());

  // Click overlay to dismiss
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) _callbacks.onSkip?.();
  });
}

// ── Positioning ──────────────────────────────────────────────

const MARGIN = 12;
const ARROW_SIZE = 8;

function fitPosition(positions, targetRect, tooltipRect, vw, vh) {
  for (const pos of positions) {
    if (pos === 'bottom' && targetRect.bottom + MARGIN + tooltipRect.height < vh) return pos;
    if (pos === 'top' && targetRect.top - MARGIN - tooltipRect.height > 0) return pos;
    if (pos === 'right' && targetRect.right + MARGIN + tooltipRect.width < vw) return pos;
    if (pos === 'left' && targetRect.left - MARGIN - tooltipRect.width > 0) return pos;
  }
  return positions[0];
}

function positionTooltip(targetEl, preferredPosition) {
  const targetRect = targetEl.getBoundingClientRect();
  const tooltipRect = _tooltip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Update overlay cutout to highlight target
  const pad = 4;
  _overlay.style.setProperty('--cutout-top', `${targetRect.top - pad}px`);
  _overlay.style.setProperty('--cutout-left', `${targetRect.left - pad}px`);
  _overlay.style.setProperty('--cutout-width', `${targetRect.width + pad * 2}px`);
  _overlay.style.setProperty('--cutout-height', `${targetRect.height + pad * 2}px`);

  // Try positions in order of preference
  const positions = [preferredPosition, 'bottom', 'top', 'right', 'left'].filter(Boolean);
  const chosen = fitPosition(positions, targetRect, tooltipRect, vw, vh);

  let top, left;
  const centerX = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
  const centerY = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2;

  switch (chosen) {
    case 'bottom':
      top = targetRect.bottom + MARGIN + ARROW_SIZE;
      left = Math.max(8, Math.min(centerX, vw - tooltipRect.width - 8));
      break;
    case 'top':
      top = targetRect.top - tooltipRect.height - MARGIN - ARROW_SIZE;
      left = Math.max(8, Math.min(centerX, vw - tooltipRect.width - 8));
      break;
    case 'right':
      top = Math.max(8, Math.min(centerY, vh - tooltipRect.height - 8));
      left = targetRect.right + MARGIN + ARROW_SIZE;
      break;
    case 'left':
      top = Math.max(8, Math.min(centerY, vh - tooltipRect.height - 8));
      left = targetRect.left - tooltipRect.width - MARGIN - ARROW_SIZE;
      break;
  }

  _tooltip.style.top = `${top}px`;
  _tooltip.style.left = `${left}px`;

  // Position arrow
  _arrow.className = `guide-arrow guide-arrow-${chosen}`;

  if (chosen === 'bottom' || chosen === 'top') {
    const arrowLeft = targetRect.left + targetRect.width / 2 - left;
    _arrow.style.left = `${Math.max(12, Math.min(arrowLeft, tooltipRect.width - 12))}px`;
    _arrow.style.top = '';
  } else {
    const arrowTop = targetRect.top + targetRect.height / 2 - top;
    _arrow.style.top = `${Math.max(12, Math.min(arrowTop, tooltipRect.height - 12))}px`;
    _arrow.style.left = '';
  }
}

// ── Public API ───────────────────────────────────────────────

export function showTooltip({ target, title, body, position, step, total, onNext, onBack, onSkip }) {
  ensureDOM();

  const targetEl = typeof target === 'string' ? document.querySelector(target) : target;
  if (!targetEl) {
    console.warn(`[guide] Target not found: ${target}`);
    return false;
  }

  _currentTarget = targetEl;
  _callbacks = { onNext, onBack, onSkip };

  // Scroll target into view if needed
  targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Update content
  _tooltip.querySelector('.guide-title').textContent = title || '';
  _tooltip.querySelector('.guide-body').textContent = body || '';
  _tooltip.querySelector('.guide-step-counter').textContent = total > 1 ? `${step} of ${total}` : '';

  // Button visibility
  const btnBack = _tooltip.querySelector('.guide-btn-back');
  const btnNext = _tooltip.querySelector('.guide-btn-next');
  btnBack.style.display = step > 1 ? '' : 'none';
  btnNext.textContent = step === total ? 'Done' : 'Next';

  // Attach to DOM
  if (!_overlay.parentNode) {
    document.body.appendChild(_overlay);
    document.body.appendChild(_tooltip);
  }

  // Position after DOM attachment (need layout for getBoundingClientRect)
  requestAnimationFrame(() => {
    positionTooltip(targetEl, position);
    _tooltip.classList.add('visible');
    _overlay.classList.add('visible');
  });

  return true;
}

export function hideTooltip() {
  if (_overlay) {
    _overlay.classList.remove('visible');
    _overlay.remove();
  }
  if (_tooltip) {
    _tooltip.classList.remove('visible');
    _tooltip.remove();
  }
  _currentTarget = null;
  _callbacks = {};
}

export function repositionTooltip() {
  if (!_currentTarget || !_tooltip.parentNode) return;
  // If target was removed from DOM, hide
  if (!_currentTarget.isConnected) {
    hideTooltip();
    return;
  }
  positionTooltip(_currentTarget, _tooltip.dataset.position);
}
