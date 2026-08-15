/**
 * Parser for `\criticize{message}{severity}{confidence}` annotations, built
 * on the shared brace-balanced macro scanner (`@utils/text/braceBalancedMacro`)
 * also used by `stripCriticizeAnnotations` in `replacement/advanced.ts` to
 * remove these annotations from output. Both recognize the same macro shape;
 * this layer adds severity/confidence validation and source line/column
 * positions for editor decorations, which the stripper doesn't need.
 *
 * No `vscode` import — usable from agent core too.
 */

import { findBraceBalancedMacroCalls } from '@utils/text/braceBalancedMacro';

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
  for (const call of findBraceBalancedMacroCalls(source, MACRO, 3)) {
    const [message, severityText, confidenceText] = call.args;
    const severity = parseIntegerOrNaN(severityText.trim());
    const confidence = parseIntegerOrNaN(confidenceText.trim());
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
