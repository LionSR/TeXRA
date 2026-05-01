/**
 * Parser for `\criticize{message}{severity}{confidence}` annotations inserted
 * by critique-style agents (criticize, notation, elevate, verifyFix, ...).
 *
 * Returns each occurrence with its position so the extension host can surface
 * them as VS Code diagnostics. Brace-balanced so `\criticize{...\cref{x}...}`
 * style nesting is handled correctly (the regex in `replacement/advanced.ts`
 * only allows one level of nesting).
 *
 * Pure text in / data out — no `vscode` import so this stays usable in the
 * agent core too.
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

/**
 * Read one brace-balanced `{...}` argument starting at `source[index]`.
 * Returns the inner text and the index of the character after the closing `}`.
 * Returns null if the argument is malformed (unbalanced braces, no opening `{`).
 */
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

/** Convert a 0-based char offset into 0-based (line, column). */
function offsetToLineCol(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

/**
 * Parse all `\criticize{message}{severity}{confidence}` occurrences in `source`.
 *
 * Severity/confidence are parsed as integers. If the second/third arg isn't
 * a clean integer (e.g. older single-arg form `\criticize{Fixed: ...}`), the
 * occurrence is skipped — those agents render visually but don't carry the
 * severity metadata diagnostics need.
 */
export function parseCriticismAnnotations(
  source: string,
): CriticismAnnotation[] {
  if (!source.includes(MACRO)) return [];

  const out: CriticismAnnotation[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const macroAt = source.indexOf(MACRO, searchFrom);
    if (macroAt === -1) break;

    // Guard against partial matches like `\criticizeFoo`.
    const after = source[macroAt + MACRO.length];
    if (after !== '{') {
      searchFrom = macroAt + MACRO.length;
      continue;
    }

    const arg1 = readBraceGroup(source, macroAt + MACRO.length);
    if (!arg1) {
      searchFrom = macroAt + MACRO.length;
      continue;
    }
    const arg2 = readBraceGroup(source, arg1.end);
    if (!arg2) {
      searchFrom = arg1.end;
      continue;
    }
    const arg3 = readBraceGroup(source, arg2.end);
    if (!arg3) {
      searchFrom = arg2.end;
      continue;
    }

    const severity = Number.parseInt(arg2.content.trim(), 10);
    const confidence = Number.parseInt(arg3.content.trim(), 10);
    if (
      Number.isFinite(severity) &&
      Number.isFinite(confidence) &&
      severity >= 1 &&
      severity <= 5
    ) {
      const { line, column } = offsetToLineCol(source, macroAt);
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
