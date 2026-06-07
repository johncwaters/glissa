// The single display source of truth for Glissa's keyboard shortcuts, rendered by the Settings dialog's
// Shortcuts tab (dialogs.js). Pure data, no DOM, so it is unit-testable in node:test. The actual key
// HANDLERS live in app.js (the Alt + '?' document listeners) and session-card/terminal.js (the xterm
// skip / clipboard keys); keep this list in sync with them when a binding changes.
//
// Shape: an ordered list of groups. Each item has `combos` (one or more chords) and a `label`. A chord
// is an array of key captions rendered as <kbd> chips joined by '+'; multiple combos render joined by a
// faint '/'. Arrow captions are built with String.fromCharCode so the source stays plain ASCII (this is
// a no-dash repo; non-ASCII glyphs are never written as literals).

const UP = String.fromCharCode(0x2191);
const DOWN = String.fromCharCode(0x2193);
const LEFT = String.fromCharCode(0x2190);
const RIGHT = String.fromCharCode(0x2192);

export const SHORTCUT_GROUPS = [
  {
    title: 'Navigation',
    items: [
      { combos: [['Alt', UP], ['Alt', DOWN]], label: 'Previous / next session' },
      { combos: [['Alt', '1-9']], label: 'Focus session by number' },
      { combos: [[UP], [DOWN]], label: 'Move rail highlight (rail focused)' },
      { combos: [[LEFT], [RIGHT]], label: 'Switch view tab (tab focused)' },
    ],
  },
  {
    title: 'Triage',
    items: [
      { combos: [['Alt', 'W']], label: 'Next session that needs you' },
    ],
  },
  {
    title: 'Review',
    items: [
      { combos: [['Alt', 'M']], label: 'Merge the selected session' },
      { combos: [['Alt', 'R']], label: 'Resolve a parked merge in its session' },
    ],
  },
  {
    title: 'Sessions',
    items: [
      { combos: [['Alt', '0']], label: 'Add a session' },
      { combos: [['Enter']], label: 'Open highlighted session' },
    ],
  },
  {
    title: 'Terminal',
    items: [
      { combos: [['Ctrl', 'C']], label: 'Copy selection' },
      { combos: [['Ctrl', 'V']], label: 'Paste' },
      { combos: [['Ctrl', 'Backspace']], label: 'Delete previous word' },
    ],
  },
  {
    title: 'General',
    items: [
      { combos: [['?']], label: 'Open this help' },
      { combos: [['Esc']], label: 'Close dialog / cancel rename' },
    ],
  },
];
