# Product

## Users

A single power user: a developer running many Claude Code agents at once, on Windows or against a Linux server, often late and often tired. Their context is a 27-inch monitor in a dim room at 2am, several live terminals in view, attention split across sessions that each move at their own pace. They are not browsing; they are on watch.

The job to be done: spawn, monitor, and steer dozens of Claude Code sessions from one screen without alt-tabbing between windows, losing track of which agent is waiting for input, or missing the moment one finishes or fails. Glissa is local-first (localhost by default, single user, with opt-in paired remote access from their own phone), so the operator already trusts the machine; what they need from the interface is honest, legible state. The primary task on any given screen is triage: scan the board, find the session that needs a human, act, return to watching.

## Product Purpose

Glissa is a lightweight background process that spawns and manages Claude Code sessions, streams their live terminal output to a browser dashboard over WebSocket, and raises native browser notifications when a session needs attention, finishes, or fails (with opt-in OS toast as a fallback). It exists because running multiple Claude Code sessions across separate terminal windows is chaos: work piles up during context-switches and the moment that matters (an agent waiting on input) is easy to miss.

Success looks like an operator keeping a dozen agents productive from one screen, never missing the instant a session needs them, and never having to interpret or second-guess what they are seeing. The interface earns its keep by disappearing: the terminal output is the product, and the chrome exists only to route attention to the right session at the right time.

## Brand Personality

Precise, quiet, uncanny. The console is a machine intelligence watching its constructs through the night: it never blinks and never raises its voice. Voice is even, technical, and unsentimental, carried entirely in monospace. It does not entertain, reassure, or editorialize. It reports. Calm is the resting state; a signal is an event, not decoration. When the interface does speak, in color, motion, or a notification, it means something real has changed.

## Anti-references

- **The generic AI-SaaS dashboard.** No gradient hero, no rounded glass cards, no purple-to-blue gradient, no Inter. If the domain ("AI agent tool") could predict the look, it is wrong.
- **The IDE / VS Code clone.** Glissa is a monitor, not an editor. It watches sessions; it does not pretend to be a workspace.
- **The toy aesthetic.** No cartoonish rounded-everything, no primary-color palette, no playful mascotry. This is a control room.
- **The safe corporate committee look.** No IBM-blue enterprise design, no design-by-consensus blandness.
- **Decoration that means nothing.** Gradient text, glassmorphism-as-default, side-stripe accents, resting drop shadows, and any color or motion spent on something that is not a real state change.

## Design Principles

- **Earned signal.** Every color and every motion means a real state change. A state color that means nothing teaches the operator to ignore it; a red on screen is a real failure. The operator must be able to trust the board enough to act on what they see without re-checking. This is the strategic core: the felt goal is "I trust the board."
- **The terminal is the product.** Chrome recedes so live output holds the eye. If a pixel does not carry data or guide the eye to data, it is cut. The interface succeeds by getting out of the way.
- **Quiet by default, loud only on change.** The resting state is calm and recessive. The system raises its voice (a glow, a pulse, a toast) only when a session genuinely needs a human. Density is welcome where it pays for sustained watching, but the surface stays still until something happens.
- **State is structural, never guessed.** Status comes from machine-emitted signals (Claude Code hooks, with an OSC-0 title fallback), never from scraping the rendered screen. The interface only ever shows state it actually knows. An unknown is shown as unknown, never as a confident guess. Honesty over reassurance.
- **One voice.** A single accent and a single typeface family carry the whole interface; hierarchy is built from weight, tracking, color, and case, not from a second hue or a louder font. Restraint is the identity.

## Accessibility & Inclusion

- **Target: WCAG AA.** Text colors meet AA contrast on the canvas, card, and inset surfaces.
- **Color-blind safe by construction.** State is never carried by hue alone. Every state reads through glyph plus shape plus color (and, at miniature scale in the minimized bar, through motion: amber-and-pulsing versus green-and-steady differ on hue, saturation, and animation at once).
- **Reduced motion is honored strictly.** No animation runs unless the operator opts in via `prefers-reduced-motion`.
- **Keyboard-first.** Every interactive element ships a visible 2px accent focus ring with an offset; focus is never removed without a replacement. The tool is operated by a developer who lives on the keyboard.
