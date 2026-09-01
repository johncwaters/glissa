// Unicode "Other": control, format and surrogate code points, none of which belong on a single line.
const OTHER_CATEGORY_RE = /\p{C}+/gu;

function firstLine(text: unknown): string {
  return String(text == null ? '' : text).split(/\r?\n/)[0].trim();
}

// One line by construction. Glissa-authored lines are single-line, so text normalized here can never
// forge one, whether it came from a memory record or from a model reading an untrusted buffer.
function sanitizeOneLine(raw: unknown, maxChars: number): string {
  const value = String(raw == null ? '' : raw)
    .replace(OTHER_CATEGORY_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.slice(0, maxChars).trim();
}

export { firstLine, sanitizeOneLine };
