/**
 * Untruncated text plus the measurements a host needs to paint an elided
 * form of it.
 *
 * Every text a transcript row carries is complete. A host that cannot show
 * all of it picks a head/tail budget at paint time and calls
 * {@link elideText}; the counts it reports ("+N lines") come from the same
 * measurement both hosts hold, so a terminal and a webview can never disagree
 * on how much was hidden. Nothing here knows about terminal columns — width
 * is applied by the painter, never by the model.
 */
import yaml from 'yaml';

import { collapseWhitespace, splitContentLines } from '@utils/text/stringUtils';

export interface TextMetrics {
  /** Lines in the untruncated text; a trailing newline is not a line. */
  readonly lineCount: number;
  /** UTF-16 length of the untruncated text. */
  readonly charCount: number;
}

/** One text-bearing field of a transcript row. */
export interface TranscriptText extends TextMetrics {
  /** The complete text, exactly as the producer wrote it. */
  readonly full: string;
  /** Whitespace-collapsed single line — still untruncated. For one-line
   *  density paints and for equality tests between two texts. */
  readonly oneLine: string;
}

const EMPTY_TRANSCRIPT_TEXT: TranscriptText = {
  full: '',
  oneLine: '',
  lineCount: 0,
  charCount: 0,
};

export function transcriptText(raw: string): TranscriptText {
  if (!raw) return EMPTY_TRANSCRIPT_TEXT;
  return {
    full: raw,
    oneLine: collapseWhitespace(raw),
    lineCount: splitContentLines(raw).length,
    charCount: raw.length,
  };
}

/** Head/tail line budget a host chooses for one paint. */
interface TextBudget {
  readonly headLines: number;
  readonly tailLines: number;
}

interface ElidedText {
  readonly head: readonly string[];
  readonly tail: readonly string[];
  /** Lines between `head` and `tail`; zero when nothing was hidden. */
  readonly hiddenLines: number;
}

/**
 * Split a text into the lines a host will paint under its own budget. The
 * elision only ever removes whole lines from the middle, so the first and
 * last lines of an output stay visible at any budget.
 */
export function elideText(
  text: TranscriptText,
  budget: TextBudget,
): ElidedText {
  const lines = splitContentLines(text.full);
  const headLines = Math.max(0, budget.headLines);
  const tailLines = Math.max(0, budget.tailLines);
  if (lines.length <= headLines + tailLines) {
    return { head: lines, tail: [], hiddenLines: 0 };
  }
  return {
    head: lines.slice(0, headLines),
    tail: tailLines > 0 ? lines.slice(lines.length - tailLines) : [],
    hiddenLines: lines.length - headLines - tailLines,
  };
}

/** Serialization format {@link stringifyPayload} chose for a value. */
export type PayloadLanguage = 'yaml' | 'plaintext';

export interface PayloadText {
  readonly text: TranscriptText;
  readonly language: PayloadLanguage;
}

/**
 * Display projection of an untyped payload, with the format it was rendered
 * in so a host can syntax-highlight it. Strings pass through; everything else
 * becomes YAML, falling back to `String(value)` when the serializer refuses.
 */
export function stringifyPayload(value: unknown): PayloadText {
  if (value == null) {
    return { text: EMPTY_TRANSCRIPT_TEXT, language: 'plaintext' };
  }
  if (typeof value === 'string') {
    return { text: transcriptText(value), language: 'plaintext' };
  }
  try {
    return {
      text: transcriptText(yaml.stringify(value).trimEnd()),
      language: 'yaml',
    };
  } catch {
    return { text: transcriptText(String(value)), language: 'plaintext' };
  }
}
