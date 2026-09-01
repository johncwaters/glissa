// WebGL context pool with an LRU cap. Browsers drop the oldest context at ~16
// and silently fall EVERY terminal back to canvas under that pressure; we evict
// our own least-recently-used context first so the cap is predictable and the
// evicted card (not an arbitrary one) is the one that degrades to canvas. The
// pure eviction policy lives in webgl-core.mjs.

import { WebglAddon } from '@xterm/addon-webgl';
import { uiState } from '../ui-state-core.ts';
import { sessionUIs } from './card-registry.js';
import { pickEvictionVictims } from './webgl-core.mjs';

// A mobile GPU drops contexts far below the desktop ceiling, so a coarse pointer takes a much tighter
// cap. Read once at module init: a device does not change pointer class mid-session, and the cap must
// be a constant for the LRU policy to be predictable.
const MAX_WEBGL_CONTEXTS = window.matchMedia?.('(pointer: coarse)').matches ? 4 : 12;
const _webglLru = new Map(); // ui -> true; insertion order = LRU, oldest first

export function releaseWebgl(ui) {
  _webglLru.delete(ui);
  if (ui.webglAddon) {
    try { ui.webglAddon.dispose(); } catch { /* already gone */ }
    ui.webglAddon = null;
  }
}

function evictWebglIfNeeded(exceptUi) {
  const protectedUis = [exceptUi];
  const borrowedUi = sessionUIs.get(uiState.snapshot().borrowedCardId);
  if (borrowedUi) protectedUis.push(borrowedUi);
  for (const victim of pickEvictionVictims([..._webglLru.keys()], MAX_WEBGL_CONTEXTS, protectedUis)) {
    releaseWebgl(victim);
    victim.needsWebGLReload = true; // recreated when it next becomes visible
  }
}

// The other half of eviction, and the only reader of the flag evictWebglIfNeeded sets. A card gives up
// its context while off-screen and takes one back when it is shown again, so the cap follows what the
// operator is actually looking at. Without this the flag was write-only and an evicted card stayed on
// the DOM renderer permanently - on a phone, where the cap is 4, that is every session past the fourth
// for the rest of the page's life. A no-op for a card that never lost its context.
export function reacquireWebglIfEvicted(ui) {
  if (!ui?.term || !ui.needsWebGLReload) return;
  tryLoadWebGL(ui);
}

export function tryLoadWebGL(ui) {
  try {
    // Already have a healthy context: just refresh LRU recency and return.
    // Don't tear down and rebuild a live GL context on a no-op call (e.g. every
    // visible card on reorder): context creation is expensive and rebuilding a
    // healthy one works against the GPU-pressure goal this cap exists for.
    if (ui.webglAddon && !ui.needsWebGLReload) {
      _webglLru.delete(ui);
      _webglLru.set(ui, true); // move to most-recently-used
      return;
    }
    if (ui.webglAddon) {
      ui.webglAddon.dispose();
      ui.webglAddon = null;
      _webglLru.delete(ui);
    }
    // Evict the least-recently-used context before claiming a new one.
    evictWebglIfNeeded(ui);
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      ui.webglAddon = null;
      _webglLru.delete(ui);
      ui.needsWebGLReload = true;
    });
    ui.term.loadAddon(addon);
    ui.webglAddon = addon;
    ui.needsWebGLReload = false;
    _webglLru.set(ui, true); // mark most-recently-used (inserts at end)
    // A freshly attached GL context can miss its first full refresh while paused.
    // Defer one frame so the card is on-screen before repainting every row.
    requestAnimationFrame(() => {
      if (ui.webglAddon !== addon || !ui.term) return;
      ui.term.refresh(0, ui.term.rows - 1);
    });
  } catch {
    ui.webglAddon = null;
    ui.needsWebGLReload = false;
    _webglLru.delete(ui);
  }
}
