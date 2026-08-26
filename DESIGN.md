---
name: Glissa
description: A calm operator console for watching and steering many live Claude Code sessions.
colors:
  accent: "#c084fc"
  accent-dim: "#9656d6"
  bg: "#0a0810"
  bg-card: "#100e18"
  bg-header: "#0c0a14"
  bg-surface: "#16122a"
  border: "#2a2440"
  border-dim: "#1e1a32"
  border-hover: "#3e3660"
  text: "#c8c0e0"
  text-dim: "#8d82b9"
  text-head: "#e8e0ff"
  text-muted: "#8579b1"
  state-running: "#22c55e"
  state-waiting: "#f59e0b"
  state-failed: "#ef4444"
  state-done: "#67e8f9"
  state-idle: "#eab308"
  state-starting: "#f472b6"
  state-complete: "#34d399"
  state-initializing: "#6b7280"
typography:
  headline:
    fontFamily: "Cascadia Code, Fira Code, Consolas, Menlo, monospace"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.1em"
  title:
    fontFamily: "Cascadia Code, Fira Code, Consolas, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.04em"
  body:
    fontFamily: "Cascadia Code, Fira Code, Consolas, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  caption:
    fontFamily: "Cascadia Code, Fira Code, Consolas, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0.02em"
  label:
    fontFamily: "Cascadia Code, Fira Code, Consolas, Menlo, monospace"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  sm: "4px"
  lg: "5px"
  pill: "2px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "8px 18px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
  input:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-head}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  input-focus:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-head}"
  card:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "20px 28px"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.text-head}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
---

# Design System: Glissa

## 1. Overview

**Creative North Star: "The Phyrexian Console"**

Glissa is a machine intelligence watching its constructs through the night. The surface is deep oil-black tinted toward violet; a single iridescent orchid accent is the only chromatic voice in the chrome. State surfaces as cold, exact glints, a glow here, a flash there, only when something actually changes. The console is precise, unsentimental, and a little uncanny: it never blinks and never raises its voice. The operator should feel in command of a board of live agents, not entertained by it.

Everything is monospace. Type is the voice of the interface, and the voice is even, technical, and quiet. Density is welcome where it pays for itself: the operator is watching several terminals at 2am and the layout must reward sustained attention, not a glance. Chrome recedes so the terminal output (the real product) holds the eye. Ornament is treated as suspicious. If a pixel does not carry data or guide the eye to data, it is cut.

This system explicitly rejects the generic AI-SaaS dashboard (no gradient hero, no rounded glass cards, no purple-to-blue gradient, no Inter), the IDE clone (Glissa is a monitor, not an editor), the toy aesthetic (no cartoonish rounding, no primary-color palettes), and the safe corporate committee look (no IBM-blue enterprise design). It is a control room, not a marketing page.

**Key Characteristics:**
- Mono-forward: one typeface family carries headings, labels, data, and body.
- Oil-black violet surfaces with one iridescent accent used sparingly.
- Flat by default; depth comes from tonal layering and 1px borders, never resting shadows.
- Color and motion are reserved for genuine state signals, so a signal always means something.
- Compressed type scale (10px to 16px); hierarchy is built from weight, tracking, color, and case, not size.
- Four shipping themes (Phyrexian is the default); the system is theme-agnostic and reads colors from CSS variables.

## 2. Colors

A near-monochrome violet-tinted dark palette with one iridescent accent and a strict, color-blind-safe vocabulary of semantic state colors. Phyrexian (the default theme) is documented here; Midnight, Golgari, and Compleated are alternate themes that swap the same token names to blue-purple, green-black, and a single light scheme respectively.

### Primary
- **Iridescent Orchid** (#c084fc): The one accent. Primary actions, current selection, focus rings, the active tab underline, the wordmark glyph, connection highlights. It appears on a small fraction of any screen on purpose.
- **Deep Orchid** (#9656d6): The accent's darker partner, for accent borders, CTA strokes, and pulse low-points where full orchid would shout.

### Neutral
- **Near-Black Violet** (#0a0810): The base canvas behind everything.
- **Ink Violet** (#100e18): Card and panel fills, the terminal pane background, one step up from the canvas.
- **Shadow Violet** (#0c0a14): The sticky header bar.
- **Deep Violet Slate** (#16122a): Inset surfaces, inputs, the next tonal step up.
- **Violet Border** (#2a2440) / **Dim Violet Border** (#1e1a32) / **Lifted Violet Border** (#3e3660): The three-step border ramp. Dim for quiet internal dividers, base for component edges, lifted for hover and elevated surfaces (menus, tooltips, dialogs).
- **Bright Lavender White** (#e8e0ff): Headings and emphasized text.
- **Soft Lavender Grey** (#c8c0e0): Default body text.
- **Muted Lavender** (#8d82b9): Secondary text, descriptions (meets WCAG AA on bg, card, and surface).
- **Faint Lavender** (#8579b1): Tertiary labels, captions, the quietest legible text (AA on bg, card, and surface).

### State (semantic, color-blind-safe)
Always paired with a glyph or shape; never carried by hue alone.
- **Signal Green** (#22c55e): Running.
- **Signal Amber** (#f59e0b): Waiting / needs attention / setup-required.
- **Signal Red** (#ef4444): Failed, disconnected, destructive.
- **Signal Cyan** (#67e8f9): Done (Phyrexian).
- **Signal Gold** (#eab308): Idle.
- **Signal Pink** (#f472b6): Starting (Phyrexian).
- **Signal Emerald** (#34d399): Complete.
- **Signal Slate** (#6b7280): Initializing.

### Named Rules
**The One Voice Rule.** Iridescent Orchid is the only accent, used on roughly 10% of any screen or less. Its rarity is the point. Never introduce a second decorative hue.

**The Earned Signal Rule.** A state color that means nothing teaches the operator to ignore it. State color appears only on a real state change, never as decoration. A red on screen is a real failure.

**The Tinted Neutral Rule.** No pure black, no pure white. Every neutral is tinted toward the brand violet. Backgrounds run near-black with a trace of violet; the lightest text is lavender-white, not #fff.

## 3. Typography

**Display Font:** none. The system is mono-forward.
**Body / UI Font:** Cascadia Code (with Fira Code, Consolas, Menlo, monospace fallbacks).
**Sans fallback:** Segoe UI / system-ui, available via a `--font-ui` token but rarely used; the console speaks in monospace.

**Character:** One programmer's-typeface voice for everything. It reads as an instrument readout, not a document. Because the family is fixed and the size range is narrow, hierarchy is carried by weight, letter-spacing, color, and uppercase, not by large type.

### Hierarchy
- **Headline** (700, 16px, 0.1em tracking, uppercase): The GLISSA wordmark and top-level bar titles. The only place tracking opens up this wide.
- **Title** (700, 14px to 16px, 0.03em to 0.04em): Dialog titles, panel names, empty-state titles.
- **Body** (400, 14px, line-height 1.5): Base reading size; the document default.
- **Caption** (400, 11px to 12px, 0.02em, line-height ~1.55): Descriptions, summaries, secondary metadata. The workhorse of the dense panels.
- **Label** (700, 10px to 11px, 0.08em tracking, uppercase): Field labels, section eyebrows, state badges. Small, tracked, and shouty-quiet.

### Named Rules
**The Weight-Not-Size Rule.** The type scale is deliberately compressed (10px to 16px). Build hierarchy with weight, tracking, color, and case. Do not reach for larger sizes to signal importance.

**The Monospace Voice Rule.** UI text is monospace. Do not introduce a sans or serif for body, labels, or data. The mono is the brand's voice.

**The Measure Rule.** Cap prose at roughly 78 to 80ch (descriptions already do). Terminal and tabular content may run denser.

## 4. Elevation

Flat by default. Surfaces sit on the canvas and are separated by tonal layering (canvas to card to inset surface) plus 1px borders, not by resting shadows. Cards and panels carry no shadow at rest; hover shifts the border color, not the elevation.

Shadows and glows exist for exactly two jobs: lifting true overlays (dialogs, menus, tooltips) off the plane, and signalling state. Both shadow color and glow color are brand-tinted, never neutral grey: the shadow base is a violet-tinted near-black, and state glows are mixed from the relevant state color.

### Shadow Vocabulary
- **shadow-sm** (`0 2px 8px` violet-tinted): subtle lift, small popovers.
- **shadow-md** (`0 4px 12px` violet-tinted): raised controls.
- **shadow-lg** (`0 8px 24px` violet-tinted): menus, tooltips, status popovers.
- **shadow-xl** (`0 8px 24px` denser violet-tinted): modal dialogs.
- **State glows**: rings and blooms mixed from a state color (for example the WAITING card's amber ring and outer bloom, the COMPLETE/FAILED completion flash, the connected dot's green glow). These are inset or tight outer shadows, always a response to state.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow or glow appears only as a response to state (hover, focus, elevation off the plane, or a live status). If a card has a resting drop shadow, it is wrong.

**The Tinted Shadow Rule.** Shadows are violet-tinted near-black (mix the accent into the shadow), never raw rgba black. Pure-black shadows read as a 2014 app.

## 5. Components

Every interactive element ships default, hover, focus-visible, active, and disabled states. Focus is always a visible 2px orchid outline with an offset; it is never removed without replacement.

### Buttons
- **Shape:** nearly square (4px radius). Tight corners reinforce the instrument feel.
- **Primary (accent-outline):** transparent fill, Iridescent Orchid text and 1px orchid border, padding 8px 18px, uppercase-ish mono with light tracking. Used for Run, Add, Save, the empty-state CTA. Hover fills with a ~14% orchid wash; disabled drops to 0.4 opacity.
- **Ghost / secondary:** transparent fill, Muted Lavender text, 1px base border, padding 6px 12px. Used for Edit, Remove, Cancel. Hover lifts the border (Remove hovers to Signal Red).
- **Icon action button:** 26x22 transparent square, glyph only. Maximize and the overflow (kebab) sit persistently in the card header; the kebab holds the secondary actions (rename, restart, remove), and the debug button appears only when debug mode is on. An invisible inset pseudo-element extends the touch target without changing the visual size. Active scales to 0.93 for tactile feedback.

### Inputs / Fields
- **Style:** Deep Violet Slate fill, 1px Violet Border, 4px radius, padding 8px 12px, Bright Lavender White text, mono 13px.
- **Focus:** border shifts to Iridescent Orchid (no glow). Placeholders use Faint Lavender.
- **Label:** sits above the field as a 10px uppercase tracked Label.
- **Error:** Signal Red caption below the field, hidden when empty.

### Cards / Containers
- **Corner style:** 5px radius (the large step).
- **Background:** Ink Violet on the Near-Black Violet canvas.
- **Border:** 1px Violet Border at rest, shifting to Lifted Violet Border on hover. No resting shadow.
- **State:** session cards drive their entire treatment from a `data-state` attribute, layering state-colored border and glow (RUNNING, WAITING, COMPLETE, FAILED, etc.). Never nest a card inside a card.
- **Internal padding:** 20px to 28px on large panels; the session-card header and terminal pane carry their own rhythm.

### Navigation
- **Primary view tabs:** mono 13px, 0.04em tracking, Muted Lavender at rest to Bright Lavender White when selected. The active tab draws a 2px orchid underline that animates in via `transform: scaleX` (ease-out-quart), never a layout shift. An optional activity dot pulses orchid when background work is running.

### State Badge (signature)
- Uppercase mono, 11px, 700, 0.08em tracking, colored by `data-state` and always preceded by a state glyph. The glyph plus the color plus the shape make state legible without relying on hue, satisfying the color-blind commitment. STARTING pulses.

### Terminal Pane (signature, the product)
- An xterm.js surface filling each card on the Ink Violet background. The server is a dumb pipe; xterm renders all ANSI. The terminal theme is derived from the active CSS-variable palette at runtime, so it stays in lockstep with the chrome. Chrome around it must never compete with it for contrast or color.

### Minimized Session Bar
The collapsed dock at the bottom of the screen. It sits in-flow below the sessions grid (which shrinks to make room) so open terminals are never overlapped. The bar is Shadow Violet with a 1px dim top border, 8px padding, and a 6px gap, and it wraps; it caps at 30vh and scrolls past that so a long dock never squeezes the live terminals.
- **Minimized card:** a 120px chip at 4px radius and 0.85 opacity (1 on hover). The terminal is hidden; the header collapses to a centered name flanked by a single state dot.
- **State at a glance:** badges are dropped; state rides the border color and the dot. Only two states get a loud treatment, RUNNING (saturated green border, a steady green dot with a soft glow) and WAITING (full amber border, amber-tinted fill, a breathing inset glow and a pulsing dot). Everything else is a quiet neutral dot at 0.45 opacity.
- **Color-blind safe by construction:** amber-plus-motion versus green-plus-steady differ on hue, saturation, and animation at once. This is the Earned Signal and Flat-By-Default rules at miniature scale.

### Permissions Badge
A small uppercase warning chip on any session spawned with skip-permissions. 11px, 700, 0.08em uppercase in the perms-warn amber-orange (#d97706), with a full 1px border and a 16% tinted fill at 2px radius. Quiet but unmistakable. Note the full border: it deliberately replaced an earlier colored `border-left`, per the side-stripe ban.

### Dropdown Menu
The header overflow menu. An Ink Violet panel with a 1px lifted border, 4px radius, and shadow-lg to lift it off the plane; min-width 180px; scales in over 100ms.
- **Items:** 11px, 600 mono, 8px 14px padding, with a fixed 1.2em mono-safe glyph column so labels stay aligned. Hover is a 6% text wash to Bright Lavender White.
- **Variants:** warning items recolor to Signal Amber, danger items to Signal Red, each tinting its own hover. A muted glyph uses a line-through to mark an off or disabled option.
- **Divider:** a 1px Violet Border rule inset 8px from each edge.

### Settings View
A primary view with a 220px grouped sidebar and one scrolling section page.
- **Navigation:** levels use 10px uppercase Faint Lavender labels; search replaces the section tree with exact-token results, and anchored rows accept stable deep links. The selected section takes orchid text, a faint orchid wash and a full 1px border. On phone, one section select replaces the sidebar above the same content column.
- **Content:** all settings in the selected section stack under anchored headings. The level tag stays beside the section title, and a sticky Save and Revert footer appears only for a dirty machine or lane section.
- **Controls:** checkboxes use an orchid accent-color; file-only values use a mono key plus a quiet config caption. Unattended controls use an amber full-border warning and inline typed confirmation. Field and footer errors use 10px Signal Red.

## 6. Do's and Don'ts

### Do:
- **Do** keep Iridescent Orchid (#c084fc) to ~10% of any screen. One voice, used rarely (the One Voice Rule).
- **Do** carry state with a glyph plus shape plus color, never hue alone. State must read for a color-blind operator.
- **Do** speak in monospace (Cascadia Code) for all UI text, and build hierarchy from weight, tracking, color, and case rather than size.
- **Do** keep surfaces flat at rest; convey depth with the canvas/card/surface tonal ramp and 1px borders.
- **Do** reserve glow and motion for genuine state changes (running, waiting, complete, failed, connecting).
- **Do** tint every neutral toward violet; use Bright Lavender White (#e8e0ff), never #fff, and Near-Black Violet (#0a0810), never #000.
- **Do** give every interactive element a visible 2px orchid focus ring with offset; the tool is keyboard-first.
- **Do** honor `prefers-reduced-motion` strictly: no animation runs without the operator opting in.
- **Do** let the terminal output be the loudest thing on screen. Chrome recedes.

### Don't:
- **Don't** build the generic AI-SaaS dashboard: no gradient hero, no rounded glass cards, no purple-to-blue gradient, no Inter.
- **Don't** make it look like a VS Code or IDE clone. Glissa is a monitor, not an editor.
- **Don't** use a children's or toy aesthetic: no cartoonish rounded-everything, no primary-color palette.
- **Don't** fall back to safe corporate enterprise design (IBM-blue committee look).
- **Don't** use gradient text (`background-clip: text` over a gradient). Emphasis comes from weight and color.
- **Don't** use glassmorphism or decorative blur. Chrome surfaces are opaque; backdrop-filter was deliberately removed from them. The one sanctioned exception is the full-screen loading / shutdown overlay (a true overlay moment, not chrome), which may blur its scrim.
- **Don't** apply a side-stripe accent (`border-left`/`border-right` > 1px as a colored stripe). Use full borders, background tints, or a leading glyph.
- **Don't** give resting surfaces a drop shadow, and never a raw rgba(0,0,0) shadow. Shadows are violet-tinted and state- or overlay-driven only.
- **Don't** add a second decorative accent hue, or spend a state color on anything that is not that state.
- **Don't** reach for a modal when an inline or progressive disclosure will do.
