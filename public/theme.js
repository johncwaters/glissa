// ── Theme management ─────────────────────────────────────────
// Single source of truth for all colors. Themes are applied by
// setting CSS custom properties on :root. The terminal theme is
// derived from CSS variables at runtime.

import { startNyanCat, stopNyanCat } from './nyan-cat.js';
import { playNyanJingle } from './alert-sound.js';

// ── Theme definitions ────────────────────────────────────────

const THEMES = {
  golgari: {
    label: 'Golgari (Green/Black)',
    colors: {
      '--bg':          '#060b08',
      '--bg-card':     '#0a120e',
      '--bg-header':   '#081009',
      '--bg-surface':  '#0e1a12',
      '--border':      '#1a2e1f',
      '--border-dim':  '#122016',
      '--border-hover':'#2a4a32',
      '--text':        '#b8ccbe',
      '--text-dim':    '#6a9070',
      '--text-head':   '#dceede',
      '--text-muted':  '#7a9a80',
      '--accent':      '#2dd4a0',
      '--accent-dim':  '#1a9a6e',

      '--state-running':      '#22c55e',
      '--state-running-bg':   'rgba(34, 197, 94, 0.06)',
      '--state-waiting':      '#f59e0b',
      '--state-waiting-bg':   'rgba(245, 158, 11, 0.08)',
      '--state-failed':       '#ef4444',
      '--state-failed-bg':    'rgba(239, 68, 68, 0.06)',
      '--state-done':         '#2dd4a0',
      '--state-done-bg':      'rgba(45, 212, 160, 0.06)',
      '--state-initializing': '#6b7280',
      '--state-initializing-bg': 'rgba(107, 114, 128, 0.06)',
      '--state-idle':         '#eab308',
      '--state-idle-bg':      'rgba(234, 179, 8, 0.06)',
      '--state-starting':     '#a78bfa',
      '--state-starting-bg':  'rgba(167, 139, 250, 0.06)',
      '--state-complete':     '#34d399',
      '--state-complete-bg':  'rgba(52, 211, 153, 0.06)',
    },
    terminal: {
      background:   '--bg-card',
      foreground:   '#c8dece',
      cursor:       '--accent',
      cursorAccent: '--bg-card',
      black:        '--border',
      brightBlack:  '--text-muted',
      red:          '#ef4444',
      brightRed:    '#f87171',
      green:        '#22c55e',
      brightGreen:  '#4ade80',
      yellow:       '#eab308',
      brightYellow: '#facc15',
      blue:         '--accent',
      brightBlue:   '#5ee8bc',
      magenta:      '#a855f7',
      brightMagenta:'#c084fc',
      cyan:         '#06b6d4',
      brightCyan:   '#22d3ee',
      white:        '#c8dece',
      brightWhite:  '#e8f5ea',
    },
  },

  midnight: {
    label: 'Midnight (Blue/Purple)',
    colors: {
      '--bg':          '#080816',
      '--bg-card':     '#0e0e20',
      '--bg-header':   '#0b0b1a',
      '--bg-surface':  '#131328',
      '--border':      '#1c1c38',
      '--border-dim':  '#141430',
      '--border-hover':'#2a2a50',
      '--text':        '#b8b8d4',
      '--text-dim':    '#8585b3',
      '--text-head':   '#dcdcf0',
      '--text-muted':  '#7c7ca9',
      '--accent':      '#4f6ef7',
      '--accent-dim':  '#3a54c0',

      '--state-running':      '#22c55e',
      '--state-running-bg':   'rgba(34, 197, 94, 0.06)',
      '--state-waiting':      '#f59e0b',
      '--state-waiting-bg':   'rgba(245, 158, 11, 0.08)',
      '--state-failed':       '#ef4444',
      '--state-failed-bg':    'rgba(239, 68, 68, 0.06)',
      '--state-done':         '#3b82f6',
      '--state-done-bg':      'rgba(59, 130, 246, 0.06)',
      '--state-initializing': '#6b7280',
      '--state-initializing-bg': 'rgba(107, 114, 128, 0.06)',
      '--state-idle':         '#eab308',
      '--state-idle-bg':      'rgba(234, 179, 8, 0.06)',
      '--state-starting':     '#a855f7',
      '--state-starting-bg':  'rgba(168, 85, 247, 0.06)',
      '--state-complete':     '#60a5fa',
      '--state-complete-bg':  'rgba(96, 165, 250, 0.06)',
    },
    terminal: {
      background:   '--bg-card',
      foreground:   '#c8c8e0',
      cursor:       '--accent',
      cursorAccent: '--bg-card',
      black:        '--border',
      brightBlack:  '--text-muted',
      red:          '#ef4444',
      brightRed:    '#f87171',
      green:        '#22c55e',
      brightGreen:  '#4ade80',
      yellow:       '#eab308',
      brightYellow: '#facc15',
      blue:         '--accent',
      brightBlue:   '#60a5fa',
      magenta:      '#a855f7',
      brightMagenta:'#c084fc',
      cyan:         '#06b6d4',
      brightCyan:   '#22d3ee',
      white:        '#c8c8e0',
      brightWhite:  '#e8e8ff',
    },
  },
  phyrexian: {
    label: 'Phyrexian (Iridescent)',
    colors: {
      '--bg':          '#0a0810',
      '--bg-card':     '#100e18',
      '--bg-header':   '#0c0a14',
      '--bg-surface':  '#16122a',
      '--border':      '#2a2440',
      '--border-dim':  '#1e1a32',
      '--border-hover':'#3e3660',
      '--text':        '#c8c0e0',
      '--text-dim':    '#8d82b9',
      '--text-head':   '#e8e0ff',
      '--text-muted':  '#8579b1',
      '--accent':      '#c084fc',
      '--accent-dim':  '#9656d6',

      '--state-running':      '#22c55e',
      '--state-running-bg':   'rgba(34, 197, 94, 0.06)',
      '--state-waiting':      '#f59e0b',
      '--state-waiting-bg':   'rgba(245, 158, 11, 0.08)',
      '--state-failed':       '#ef4444',
      '--state-failed-bg':    'rgba(239, 68, 68, 0.06)',
      '--state-done':         '#67e8f9',
      '--state-done-bg':      'rgba(103, 232, 249, 0.06)',
      '--state-initializing': '#6b7280',
      '--state-initializing-bg': 'rgba(107, 114, 128, 0.06)',
      '--state-idle':         '#eab308',
      '--state-idle-bg':      'rgba(234, 179, 8, 0.06)',
      '--state-starting':     '#f472b6',
      '--state-starting-bg':  'rgba(244, 114, 182, 0.06)',
      '--state-complete':     '#34d399',
      '--state-complete-bg':  'rgba(52, 211, 153, 0.06)',
    },
    terminal: {
      background:   '--bg-card',
      foreground:   '#c8c0e0',
      cursor:       '--accent',
      cursorAccent: '--bg-card',
      black:        '--border',
      brightBlack:  '--text-muted',
      red:          '#ef4444',
      brightRed:    '#f87171',
      green:        '#22c55e',
      brightGreen:  '#4ade80',
      yellow:       '#eab308',
      brightYellow: '#facc15',
      blue:         '#67e8f9',
      brightBlue:   '#a5f3fc',
      magenta:      '--accent',
      brightMagenta:'#d8b4fe',
      cyan:         '#06b6d4',
      brightCyan:   '#22d3ee',
      white:        '#c8c0e0',
      brightWhite:  '#e8e0ff',
    },
  },
  compleated: {
    label: 'Compleated (Light)',
    colors: {
      '--bg':          '#ece8e0',
      '--bg-card':     '#f7f4ee',
      '--bg-header':   '#f0ece4',
      '--bg-surface':  '#e4e0d6',
      '--border':      '#b8b0a0',
      '--border-dim':  '#ccc6b8',
      '--border-hover':'#908878',
      '--text':        '#2a2622',
      '--text-dim':    '#5a5448',
      '--text-head':   '#0e0c0a',
      '--text-muted':  '#676157',
      '--accent':      '#0e0c0a',
      '--accent-dim':  '#2a2622',

      '--state-running':      '#16803c',
      '--state-running-bg':   'rgba(22, 128, 60, 0.08)',
      '--state-waiting':      '#b45309',
      '--state-waiting-bg':   'rgba(180, 83, 9, 0.08)',
      '--state-failed':       '#dc2626',
      '--state-failed-bg':    'rgba(220, 38, 38, 0.06)',
      '--state-done':         '#1a1816',
      '--state-done-bg':      'rgba(26, 24, 22, 0.06)',
      '--state-initializing': '#6b7280',
      '--state-initializing-bg': 'rgba(107, 114, 128, 0.06)',
      '--state-idle':         '#a16207',
      '--state-idle-bg':      'rgba(161, 98, 7, 0.06)',
      '--state-starting':     '#7c3aed',
      '--state-starting-bg':  'rgba(124, 58, 237, 0.06)',
      '--state-complete':     '#059669',
      '--state-complete-bg':  'rgba(5, 150, 105, 0.06)',
    },
    terminal: {
      background:   '#faf8f4',
      foreground:   '#1a1816',
      cursor:       '#1a1816',
      cursorAccent: '#faf8f4',
      black:        '#1a1816',
      brightBlack:  '#5a5448',
      red:          '#b91c1c',
      brightRed:    '#dc2626',
      green:        '#15803d',
      brightGreen:  '#16a34a',
      yellow:       '#92400e',
      brightYellow: '#a16207',
      blue:         '#1d4ed8',
      brightBlue:   '#2563eb',
      magenta:      '#6d28d9',
      brightMagenta:'#7c3aed',
      cyan:         '#0e7490',
      brightCyan:   '#0891b2',
      white:        '#5a5448',
      brightWhite:  '#3a3630',
    },
  },
  unicorn: {
    label: 'Rainbow Unicorns (Pastel)',
    colors: {
      '--bg':          '#e8e2ee',
      '--bg-card':     '#efe9f5',
      '--bg-header':   '#ece4f2',
      '--bg-surface':  '#ddd2e6',
      '--border':      '#c0aed1',
      '--border-dim':  '#d3c3de',
      '--border-hover':'#a68fbf',
      '--text':        '#3d2c52',
      '--text-dim':    '#6b5686',
      '--text-head':   '#241733',
      '--text-muted':  '#705c88',
      '--accent':      '#a8477b',
      '--accent-dim':  '#8a3a66',

      '--state-running':      '#3f7d52',
      '--state-running-bg':   'rgba(63, 125, 82, 0.08)',
      '--state-waiting':      '#9c6b28',
      '--state-waiting-bg':   'rgba(156, 107, 40, 0.08)',
      '--state-failed':       '#b3453f',
      '--state-failed-bg':    'rgba(179, 69, 63, 0.06)',
      '--state-done':         '#a8477b',
      '--state-done-bg':      'rgba(168, 71, 123, 0.06)',
      '--state-initializing': '#7a7086',
      '--state-initializing-bg': 'rgba(122, 112, 134, 0.06)',
      '--state-idle':         '#8a7333',
      '--state-idle-bg':      'rgba(138, 115, 51, 0.06)',
      '--state-starting':     '#6b4fa0',
      '--state-starting-bg':  'rgba(107, 79, 160, 0.06)',
      '--state-complete':     '#9c4f96',
      '--state-complete-bg':  'rgba(156, 79, 150, 0.06)',
    },
    terminal: {
      background:   '#efe9f5',
      foreground:   '#2a1d3d',
      cursor:       '--accent',
      cursorAccent: '#efe9f5',
      black:        '#2a1d3d',
      brightBlack:  '#6b5686',
      red:          '#b3453f',
      brightRed:    '#c25a54',
      green:        '#3f7d52',
      brightGreen:  '#4f9161',
      yellow:       '#8a7333',
      brightYellow: '#a3873f',
      blue:         '#3f5f9e',
      brightBlue:   '#4d72b5',
      magenta:      '#9c4f96',
      brightMagenta:'#b062ab',
      cyan:         '#2f7a82',
      brightCyan:   '#3f93a0',
      white:        '#6b5686',
      brightWhite:  '#3d2c52',
    },
  },
};

const DEFAULT_THEME = 'phyrexian';

// ── Application ──────────────────────────────────────────────

let _currentThemeId = null;

/**
 * Apply a theme by setting CSS variables on :root.
 * @param {string} themeId
 */
export function applyTheme(themeId) {
  const theme = THEMES[themeId];
  if (!theme) return;

  const prev = _currentThemeId;
  _currentThemeId = themeId;
  const root = document.documentElement;
  root.dataset.theme = themeId;
  for (const [prop, value] of Object.entries(theme.colors)) {
    root.style.setProperty(prop, value);
  }

  if (themeId === 'unicorn') {
    startNyanCat();
    if (prev !== null && prev !== 'unicorn') {
      playNyanJingle();
    }
    return;
  }
  stopNyanCat();
}

/**
 * Build an xterm.js theme object from the current theme.
 * Terminal values starting with '--' are resolved from CSS variables.
 * @returns {object} xterm theme config
 */
export function getTerminalTheme() {
  const theme = THEMES[_currentThemeId || DEFAULT_THEME];
  if (!theme) return {};

  const style = getComputedStyle(document.documentElement);
  const result = {};
  for (const [key, value] of Object.entries(theme.terminal)) {
    result[key] = value.startsWith('--') ? style.getPropertyValue(value).trim() : value;
  }
  return result;
}

/** @returns {Array<{id: string, label: string}>} available themes */
export function getThemeList() {
  return Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label }));
}
