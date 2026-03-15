// ── Guide engine ─────────────────────────────────────────────
// Manages guided tutorials: registration, state tracking, step progression.
// Completed guides are persisted via ui-prefs (localStorage).

import { showTooltip, hideTooltip, repositionTooltip } from './guide-tooltip.js';
import { getCompletedGuides, addCompletedGuide } from './ui-prefs.js';

// ── Registry ─────────────────────────────────────────────────

const _guides = new Map();
let _activeGuideId = null;
let _activeStep = 0;
let _escHandler = null;
let _resizeHandler = null;

// ── Registration ─────────────────────────────────────────────

/**
 * Register a guide definition.
 * @param {string} id — unique guide identifier
 * @param {object} opts
 * @param {Array<{target: string, title: string, body: string, position?: string}>} opts.steps
 * @param {() => boolean} opts.condition — returns true when guide should trigger
 */
export function registerGuide(id, { steps, condition }) {
  _guides.set(id, { steps, condition });
}

// ── Conditions ───────────────────────────────────────────────

/** True when the 'welcome' guide has not been completed. */
export function isFirstOpen() {
  return !getCompletedGuides().includes('welcome');
}

// ── Guide lifecycle ──────────────────────────────────────────

export function checkAndStartGuides() {
  const completed = getCompletedGuides();
  for (const [id, guide] of _guides) {
    if (completed.includes(id)) continue;
    if (guide.condition && !guide.condition()) continue;
    startGuide(id);
    return;
  }
}

export function startGuide(id) {
  const guide = _guides.get(id);
  if (!guide) return;

  _activeGuideId = id;
  _activeStep = 0;

  // ESC to dismiss
  _escHandler = function guideEscHandler(e) {
    if (e.key !== 'Escape') return;
    // Don't consume ESC if a dialog is open
    if (document.querySelector('.dialog-overlay')) return;
    e.stopPropagation();
    dismissGuide();
  };
  document.addEventListener('keydown', _escHandler, true);

  // Reposition on resize
  _resizeHandler = () => repositionTooltip();
  window.addEventListener('resize', _resizeHandler);

  showStep();
}

function showStep() {
  const guide = _guides.get(_activeGuideId);
  if (!guide) return;

  // Skip steps with missing targets
  while (_activeStep < guide.steps.length) {
    const step = guide.steps[_activeStep];
    const targetEl = document.querySelector(step.target);
    if (targetEl) break;
    console.warn(`[guide] Skipping step ${_activeStep + 1}: target "${step.target}" not found`);
    _activeStep++;
  }

  // No more valid steps — complete the guide
  if (_activeStep >= guide.steps.length) {
    completeGuide(_activeGuideId);
    return;
  }

  const step = guide.steps[_activeStep];
  showTooltip({
    target: step.target,
    title: step.title,
    body: step.body,
    position: step.position || 'bottom',
    step: _activeStep + 1,
    total: guide.steps.length,
    onNext: () => {
      if (_activeStep >= guide.steps.length - 1) {
        completeGuide(_activeGuideId);
      } else {
        _activeStep++;
        showStep();
      }
    },
    onBack: () => {
      if (_activeStep > 0) {
        _activeStep--;
        showStep();
      }
    },
    onSkip: () => dismissGuide(),
  });
}

export function completeGuide(id) {
  cleanup();
  if (id) addCompletedGuide(id);
}

export function dismissGuide() {
  cleanup();
  // Dismissed guides are also marked complete so they don't reappear
  if (_activeGuideId) addCompletedGuide(_activeGuideId);
}

function cleanup() {
  hideTooltip();
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler, true);
    _escHandler = null;
  }
  if (_resizeHandler) {
    window.removeEventListener('resize', _resizeHandler);
    _resizeHandler = null;
  }
  _activeGuideId = null;
  _activeStep = 0;
}
