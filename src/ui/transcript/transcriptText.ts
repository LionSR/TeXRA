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

/** One text-bearing field of a transcript row. */
export interface TranscriptText {
  /** Lines in the untruncated text; a trailing newline is not a line. */
  readonly lineCount: number;
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
};

export function transcriptText(raw: string): TranscriptText {
  if (!raw) return EMPTY_TRANSCRIPT_TEXT;
  return {
    full: raw,
    oneLine: collapseWhitespace(raw),
    lineCount: splitContentLines(raw).length,
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

interface PayloadText {
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
  let serialized: string;
  try {
    serialized = yaml.stringify(value);
  } catch {
    // Transcript payloads are untyped external data, and YAML may reject cyclic
    // or custom values. Only serialization is caught, so plain-text display
    // fallback cannot mask failures in transcript measurement or state handling.
    return { text: transcriptText(String(value)), language: 'plaintext' };
  }
  return {
    text: transcriptText(serialized.trimEnd()),
    language: 'yaml',
  };
}

/**
 * `transcriptText(prev.full + chunk)` at O(chunk): the fold's live-text path
 * calls this once per provider chunk, so a long streaming row must not pay
 * for its whole text on every append. `prevEnd` is the character `prev.full`
 * ends with (or '' for an empty text), kept by the caller: reading it from
 * `prev.full` would flatten the joined text on every chunk, which is the
 * whole-text copy this exists to avoid. `oneLine` keeps the collapsed form
 * untrimmed at its tail between calls, so the whitespace a chunk boundary
 * splits collapses exactly as one pass over the joined text would; the
 * trimmed value is what the row carries.
 */
export function appendTranscriptText(
  prev: TranscriptText,
  chunk: string,
  prevEnd: string,
): TranscriptText {
  if (!chunk) return prev;
  if (!prev.full) return transcriptText(chunk);
  const full = prev.full + chunk;
  // `prev.lineCount` already counts an unterminated last line, so the
  // newlines inside the chunk move the count, plus the line the chunk opens
  // after a terminating newline, minus the one it leaves unopened. A `\r`
  // never breaks a line on its own (`normalizeLineEndings` only folds
  // `\r\n`), so a pair split across the boundary counts its `\n` once.
  const endedOnNewline = prevEnd === '\n';
  let newlines = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk.charCodeAt(i) === 10) newlines += 1;
  }
  const lineCount =
    prev.lineCount +
    newlines +
    (endedOnNewline ? 1 : 0) -
    (chunk.endsWith('\n') ? 1 : 0);
  // The whitespace `prev.oneLine` trimmed at its tail comes back as the one
  // space it collapses to, and a chunk that opens on whitespace merges into
  // it rather than doubling. Only the chunk's own collapsed form is trimmed:
  // `prev.oneLine` is already trimmed, and trimming the joined string would
  // flatten it on every append.
  const collapsed = chunk.replaceAll(/\s+/g, ' ');
  const prevEndsOnSpace = /^\s$/.test(prevEnd);
  const body =
    prevEndsOnSpace && collapsed.startsWith(' ')
      ? collapsed.slice(1)
      : collapsed;
  const tail = prev.oneLine ? body.trimEnd() : body.trim();
  const joiner = prevEndsOnSpace && prev.oneLine && tail ? ' ' : '';
  return { full, oneLine: prev.oneLine + joiner + tail, lineCount };
}
