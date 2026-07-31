> Historical document, superseded. This was the working design-context doc before the current product definition was written. Current behavior: see the root `PRODUCT.md`.

# Glissa: Design Context

## Users

Glissa is a shared open-source package. The primary user is a developer who runs Glissa as their **primary focus window** while orchestrating multiple Claude Code sessions. They are watching several live agent sessions, glancing between terminal output, state indicators, and alerts. The interface must reward sustained attention — this is not a glanceable widget, it is a workstation.

Secondary users: other developers who install the package and expect it to work well out of the box without customization.

## Brand Personality

**Precise. Unblinking. Quiet.**

Glissa behaves like a calm operator console in a control room. It is information-first. It does not demand attention — it earns it by being trustworthy and legible at 2am. Ornament is suspicious; density is welcome when it pays for itself. The tool shows state honestly and gets out of the way.

Emotional target: the user should feel *in command*, not *entertained*.

## Aesthetic Direction

**Control-room terminal** — a modern, refined take on an operator console. Deep purple-tinted dark surface is the established identity and stays. Monospace is the voice of the interface. Terminal output is the centerpiece; chrome around it should recede.

### Anti-references (explicitly NOT)
- **Generic AI SaaS dashboards** — no gradient hero, no rounded glass cards, no purple-to-blue gradient, no Inter
- **VS Code / IDE clones** — Glissa is a monitor, not an editor; do not pretend otherwise
- **Children's / toy aesthetics** — no cartoonish rounded-everything, no primary-color palettes
- **Corporate enterprise** — no safe IBM-blue committee design

### Palette
Keep the deep-purple identity, refined:
- Tighten chroma at extremes (backgrounds near-black with trace purple tint, text light with reduced chroma)
- Neutrals tinted toward the brand purple hue for subconscious cohesion
- One sharp accent for critical state signals — used rarely, so it has weight
- State colors (running/waiting/failed/done) must be distinguishable without hue — pair with glyphs/shape

### Typography
Monospace-forward. Cascadia Code / Fira Code family already in use for headers and status. Body/UI can stay mono or pair with a restrained neutral sans — but no display serifs, no novelty fonts, nothing that undercuts the operator-console feel. Hierarchy comes from weight, size, and spacing — not decoration.

### Motion
Minimal and functional. State transitions, connection dots, spinners. No ambient or decorative motion. Honor `prefers-reduced-motion` strictly.

## Design Principles

1. **Information before ornament.** If a pixel doesn't carry data or guide the eye to data, justify it or remove it.
2. **Terminal output is sacred.** The xterm pane is the product. Chrome around it must not compete with it for attention, contrast, or color.
3. **State is the story.** Session state (running/waiting/failed/done) must be unambiguous at a glance, color-blind safe, and readable across contrast conditions.
4. **Keyboard-first.** Every action reachable without a mouse, with visible focus rings. Mouse is a convenience, not a requirement.
5. **Quiet by default, loud when it matters.** Reserve accent color and motion for genuine signals. A red that means nothing teaches the user to ignore red.

## Accessibility Commitments

- **WCAG AA contrast** across all themes (4.5:1 body / 3:1 large text minimum)
- **prefers-reduced-motion** respected — no auto-playing animation without opt-in
- **Keyboard-first navigation** with visible focus rings on every interactive surface
- **Color-blind safe state indicators** — state is carried by icon/glyph/shape, not hue alone
