/**
 * The `\criticize{message}{severity}{confidence}` annotations a critique
 * program writes into a document: found once, by the brace-balanced macro
 * scanner (`@texra/utils/text/braceBalancedMacro`), then either parsed with
 * their positions for the editor's decorations or stripped from a file
 * before it is accepted.
 */

import { findBraceBalancedMacroCalls } from '@texra/utils/text/braceBalancedMacro';

interface CriticismAnnotation {
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

const INTEGER = /^\d+$/;

/** Every complete `\criticize{…}{…}{…}` call in `source`, in order. */
function criticizeCalls(source: string) {
  const macro = '\\criticize';
  return source.includes(macro)
    ? findBraceBalancedMacroCalls(source, macro, 3)
    : [];
}

function parseIntegerOrNaN(text: string): number {
  return INTEGER.test(text) ? Number.parseInt(text, 10) : NaN;
}

/**
 * Running line/column cursor: advances forward through `source` so the total
 * cost of converting many offsets stays O(N) instead of O(N × matches).
 */
class LineColCursor {
  private offset = 0;
  private line = 0;
  private lineStart = 0;
  private readonly source: string;
  constructor(source: string) {
    this.source = source;
  }

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
  const out: CriticismAnnotation[] = [];
  const cursor = new LineColCursor(source);
  for (const call of criticizeCalls(source)) {
    const [message, severityText, confidenceText] = call.args;
    const severity = parseIntegerOrNaN(severityText.trim());
    const confidence = parseIntegerOrNaN(confidenceText.trim());
    // Severity 0 (verified correct) to 5 and confidence 1 to 5: the scale
    // stated beside the macro in the `CRITICIZE` text of
    // `packages/texra/src/tools/theory/programs.ts`, which the programs that
    // write these annotations bind. A call outside it is not decorated.
    if (
      Number.isFinite(severity) &&
      Number.isFinite(confidence) &&
      severity >= 0 &&
      severity <= 5 &&
      confidence >= 1 &&
      confidence <= 5
    ) {
      const { line, column } = cursor.advanceTo(call.start);
      out.push({
        message,
        severity,
        confidence,
        line,
        column,
        length: call.end - call.start,
      });
    }
  }

  return out;
}

/**
 * Strip all `\criticize{comment}{severity}{confidence}` annotations
 * (inserted by critique-style agents) from LaTeX content. A message holding
 * nested macros (`\cref{...}`, `\frac{a}{b}`) is stripped whole. Unlike
 * {@link parseCriticismAnnotations}, this applies no severity or confidence
 * check: a malformed annotation still has to leave the output.
 */
export function stripCriticizeAnnotations(content: string): {
  content: string;
  count: number;
} {
  const calls = criticizeCalls(content);
  if (calls.length === 0) return { content, count: 0 };

  let out = '';
  let cursor = 0;
  // Tracks the start of the line containing the current call, advanced
  // forward as `calls` (already in ascending `start` order) are walked —
  // avoids a `lastIndexOf` backward-scan per call, which would be
  // O(document length) per annotation on a document with no preceding
  // newline (e.g. one long generated/minified line).
  let lineStart = 0;
  for (const call of calls) {
    let nextNewline = content.indexOf('\n', lineStart);
    while (nextNewline !== -1 && nextNewline < call.start) {
      lineStart = nextNewline + 1;
      nextNewline = content.indexOf('\n', lineStart);
    }
    const nlIndex = content.indexOf('\n', call.end);
    const lineEnd = nlIndex === -1 ? content.length : nlIndex;
    const beforeOnLine = content.slice(lineStart, call.start);
    const afterOnLine = content.slice(call.end, lineEnd);
    // Whole-line form is removed along with its trailing newline so a macro
    // occupying its own line doesn't leave a blank line behind.
    const isWholeLine =
      /^[ \t]*$/.test(beforeOnLine) && /^[ \t]*\r?$/.test(afterOnLine);

    if (isWholeLine) {
      out += content.slice(cursor, lineStart);
      cursor = nlIndex === -1 ? content.length : nlIndex + 1;
    } else {
      out += content.slice(cursor, call.start);
      cursor = call.end;
    }
  }
  out += content.slice(cursor);
  return { content: out, count: calls.length };
}
