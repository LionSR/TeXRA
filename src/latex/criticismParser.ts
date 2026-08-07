/**
 * Brace-balanced parser for `\criticize{message}{severity}{confidence}`.
 *
 * Needed in addition to the regex in `replacement/advanced.ts` because that
 * one only handles a single level of brace nesting, while messages routinely
 * contain `\cref{...}` and similar nested macros.
 *
 * No `vscode` import — usable from agent core too.
 */

export interface CriticismAnnotation {
  message: string;
  severity: number;
  confidence: number;
  /** 0-based line index in the source */
  line: number;
  /** 0-based UTF-16 column on `line` */
  column: number;
  /** Length of the matched `\criticize{...}{...}{...}` substring */
  length: number;
}

const MACRO = '\\criticize';
const INTEGER = /^\d+$/;

function parseIntegerOrNaN(text: string): number {
  return INTEGER.test(text) ? Number.parseInt(text, 10) : NaN;
}

function readBraceGroup(
  source: string,
  index: number,
): { content: string; end: number } | null {
  if (source[index] !== '{') return null;
  let depth = 1;
  let i = index + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      // Skip escaped character (handles `\{`, `\}`, `\\`)
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return { content: source.slice(index + 1, i), end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

function skipWhitespace(source: string, index: number): number {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

/**
 * Running line/column cursor: advances forward through `source` so the total
 * cost of converting many offsets stays O(N) instead of O(N × matches).
 */
class LineColCursor {
  private offset = 0;
  private line = 0;
  private lineStart = 0;
  constructor(private readonly source: string) {}

  advanceTo(target: number): { line: number; column: number } {
    while (this.offset < target) {
      if (this.source[this.offset] === '\n') {
        this.line++;
        this.lineStart = this.offset + 1;
      }
      this.offset++;
    }
    return { line: this.line, column: this.offset - this.lineStart };
  }
}

export function parseCriticismAnnotations(
  source: string,
): CriticismAnnotation[] {
  if (!source.includes(MACRO)) return [];

  const out: CriticismAnnotation[] = [];
  const cursor = new LineColCursor(source);
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const macroAt = source.indexOf(MACRO, searchFrom);
    if (macroAt === -1) break;

    const afterMacro = source[macroAt + MACRO.length];
    // Guard against partial matches like `\criticizeFoo`.
    if (afterMacro && /[A-Za-z]/.test(afterMacro)) {
      searchFrom = macroAt + MACRO.length;
      continue;
    }

    const arg1Start = skipWhitespace(source, macroAt + MACRO.length);
    const arg1 = readBraceGroup(source, arg1Start);
    if (!arg1) {
      searchFrom = macroAt + MACRO.length;
      continue;
    }
    const arg2 = readBraceGroup(source, skipWhitespace(source, arg1.end));
    if (!arg2) {
      searchFrom = arg1.end;
      continue;
    }
    const arg3 = readBraceGroup(source, skipWhitespace(source, arg2.end));
    if (!arg3) {
      searchFrom = arg2.end;
      continue;
    }

    const severity = parseIntegerOrNaN(arg2.content.trim());
    const confidence = parseIntegerOrNaN(arg3.content.trim());
    if (
      Number.isFinite(severity) &&
      Number.isFinite(confidence) &&
      severity >= 0 &&
      severity <= 5 &&
      confidence >= 1 &&
      confidence <= 5
    ) {
      const { line, column } = cursor.advanceTo(macroAt);
      out.push({
        message: arg1.content,
        severity,
        confidence,
        line,
        column,
        length: arg3.end - macroAt,
      });
    }

    searchFrom = arg3.end;
  }

  return out;
}
