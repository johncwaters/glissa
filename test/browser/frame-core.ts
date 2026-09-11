const ESC = String.fromCharCode(0x1b);
const TRAILING_WHITESPACE = /\s$/;
const STATUS_FIELDS = /cols=(\d+) rows=(\d+) tick=(\d+)/;

export const RULER = '0123456789';
export const BURST_CAP = 2000;
export const CLEAR_ALL = `${ESC}[2J${ESC}[3J${ESC}[H`;

export function rulerFill(prefix: string, cols: number): string {
  const filled: string[] = [];
  for (let column = 0; column < cols; column += 1) {
    if (column < prefix.length) {
      filled.push(prefix.charAt(column));
      continue;
    }
    filled.push(RULER.charAt((column - prefix.length) % RULER.length));
  }
  const lastColumn = cols - 1;
  if (TRAILING_WHITESPACE.test(filled[lastColumn] ?? '')) {
    filled[lastColumn] = RULER.charAt(lastColumn % RULER.length);
  }
  return filled.join('');
}

export function bodyRows(cols: number, rows: number): string[] {
  const painted: string[] = [];
  for (let row = 0; row < rows - 1; row += 1) {
    painted.push(rulerFill(`${row}|`, cols));
  }
  return painted;
}

export function statusRow(cols: number, rows: number, tick: number): string {
  return rulerFill(`cols=${cols} rows=${rows} tick=${tick} `, cols);
}

export function expectedRows(cols: number, rows: number, tick: number): string[] {
  return [...bodyRows(cols, rows), statusRow(cols, rows, tick)];
}

export function parseStatusRow(row: string): { cols: number; rows: number; tick: number } | null {
  const found = STATUS_FIELDS.exec(row);
  if (!found) return null;
  return { cols: Number(found[1]), rows: Number(found[2]), tick: Number(found[3]) };
}

export function paintFull(cols: number, rows: number, tick: number): string {
  return CLEAR_ALL + expectedRows(cols, rows, tick).join('\r\n');
}

export function repaintInPlace(cols: number, rows: number, tick: number): string {
  const cursorUp = rows > 1 ? `${ESC}[${rows - 1}A` : '';
  const painted = expectedRows(cols, rows, tick)
    .map((row) => `${ESC}[2K${row}`)
    .join('\r\n');
  return `${cursorUp}\r${painted}`;
}
