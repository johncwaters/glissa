import { WebglAddon } from '@xterm/addon-webgl';
import { uiState } from '../ui-state-core.ts';
import type { SessionUi } from './card-registry.ts';
import { sessionUIs } from './card-registry.ts';
import { pickEvictionVictims } from './webgl-core.ts';

const MAX_WEBGL_CONTEXTS = window.matchMedia?.('(pointer: coarse)').matches ? 4 : 12;
const _webglLru = new Map<SessionUi, true>();

export function releaseWebgl(ui: SessionUi) {
  _webglLru.delete(ui);
  if (ui.webglAddon) {
    try { ui.webglAddon.dispose(); } catch {  }
    ui.webglAddon = null;
  }
}

function evictWebglIfNeeded(exceptUi: SessionUi) {
  const protectedUis = [exceptUi];
  const borrowedId = uiState.snapshot().borrowedCardId;
  const borrowedUi = borrowedId ? sessionUIs.get(borrowedId) : undefined;
  if (borrowedUi) protectedUis.push(borrowedUi);
  for (const victim of pickEvictionVictims([..._webglLru.keys()], MAX_WEBGL_CONTEXTS, protectedUis)) {
    releaseWebgl(victim);
    victim.needsWebGLReload = true;
  }
}

export function reacquireWebglIfEvicted(ui: SessionUi | null | undefined) {
  if (!ui?.term || !ui.needsWebGLReload) return;
  tryLoadWebGL(ui);
}

export function tryLoadWebGL(ui: SessionUi) {
  try {
    if (ui.webglAddon && !ui.needsWebGLReload) {
      _webglLru.delete(ui);
      _webglLru.set(ui, true);
      return;
    }
    if (ui.webglAddon) {
      ui.webglAddon.dispose();
      ui.webglAddon = null;
      _webglLru.delete(ui);
    }

    evictWebglIfNeeded(ui);
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      ui.webglAddon = null;
      _webglLru.delete(ui);
      ui.needsWebGLReload = true;
    });
    const term = ui.term;
    if (!term) throw new Error('webgl: the terminal was disposed before the addon loaded');
    term.loadAddon(addon);
    ui.webglAddon = addon;
    ui.needsWebGLReload = false;
    _webglLru.set(ui, true);

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
