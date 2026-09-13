const UP = String.fromCharCode(0x2191);
const DOWN = String.fromCharCode(0x2193);
const LEFT = String.fromCharCode(0x2190);
const RIGHT = String.fromCharCode(0x2192);

export const SHORTCUT_GROUPS = [
  {
    title: 'Navigation',
    items: [
      { combos: [[UP], [DOWN]], label: 'Move rail highlight (rail focused)' },
      { combos: [[LEFT], [RIGHT]], label: 'Switch view tab (tab focused)' },
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
      { combos: [['Esc']], label: 'Close dialog / cancel rename' },
    ],
  },
];
