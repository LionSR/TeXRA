import stripAnsi from 'strip-ansi';

import { ANSI_ESCAPE_START, ansiEscapeEnd } from '@cli/runtime/ansiEscapes';
import { type StreamPhase } from '@shared/schemas';
import { isActivePhase } from '@shared/streams/streamStatus';

import type { ConversationEntry } from '../state/cliState';

const INQUIRY_CONTINUATION_RE =
  /^\[inquiry\]\s+\S+\s+(?:answered|dropped by user)\.(?:\n|$)/;
const INVISIBLE_TRANSCRIPT_CHARS = new Set([
  '\u200B',
  '\u200C',
  '\u200D',
  '\uFEFF',
]);

function isInvisibleTranscriptChar(char: string | undefined): boolean {
  return char !== undefined && INVISIBLE_TRANSCRIPT_CHARS.has(char);
}

export function terminalVisibleTranscriptText(text: string): string {
  let out = '';
  for (const char of stripAnsi(text)) {
    if (!isInvisibleTranscriptChar(char)) out += char;
  }
  return out;
}

export function isInquiryContinuationText(text: string): boolean {
  return INQUIRY_CONTINUATION_RE.test(text);
}

export function trimAssistantTranscriptLead(text: string): string {
  let index = 0;
  let consumedInvisibleLead = false;
  let leadingAnsi = '';
  while (index < text.length) {
    if (text[index] === ANSI_ESCAPE_START) {
      const end = ansiEscapeEnd(text, index);
      leadingAnsi += text.slice(index, end);
      index = end;
      continue;
    }
    if (isInvisibleTranscriptChar(text[index])) {
      index += 1;
      consumedInvisibleLead = true;
      continue;
    }
    const newline = /^[ \t]*\r?\n/.exec(text.slice(index));
    if (newline) {
      index += newline[0].length;
      consumedInvisibleLead = true;
      continue;
    }
    break;
  }
  if (!consumedInvisibleLead) return text;
  const tail = text.slice(index);
  return terminalVisibleTranscriptText(tail).trim().length > 0
    ? leadingAnsi + tail
    : tail;
}

export function isRenderableTranscriptEntry(entry: ConversationEntry): boolean {
  switch (entry.role) {
    case 'activity':
    case 'assistant':
    case 'error':
    case 'user':
    case 'phase':
    case 'workflowTask':
      return terminalVisibleTranscriptText(entry.text).trim().length > 0;
    case 'media':
      return entry.images.length > 0;
    case 'tool':
      return true;
  }
}

/** Callers gate on {@link isRenderableTranscriptEntry} before asking. */
function userPromptAwaitsLiveContinuation(
  entries: readonly ConversationEntry[],
  index: number,
  status: StreamPhase | undefined,
): boolean {
  const entry = entries[index];
  if (
    entry?.role !== 'user' ||
    isInquiryContinuationText(entry.text) ||
    !isActivePhase(status)
  ) {
    return false;
  }
  return !entries.some(
    (later, laterIndex) =>
      laterIndex > index && isRenderableTranscriptEntry(later),
  );
}

/** Whether an entry belongs in append-only terminal scrollback now. */
function isStaticTranscriptEntryAt(
  entries: readonly ConversationEntry[],
  index: number,
  status: StreamPhase | undefined,
): boolean {
  const entry = entries[index];
  return (
    entry !== undefined &&
    entry.finalized &&
    isRenderableTranscriptEntry(entry) &&
    !userPromptAwaitsLiveContinuation(entries, index, status)
  );
}

/** `(settlement order, synthetic-after-source tiebreak)` sort key for one entry. */
function transcriptOrderKey(
  entry: ConversationEntry,
  index: number,
): readonly [seq: number, synthetic: number] {
  const seq =
    entry.settlementSeqNo ??
    entry.syntheticAfterSettlementSeqNo ??
    entry.sourceSeqNo ??
    index + 1;
  const synthetic = entry.syntheticAfterSettlementSeqNo !== undefined ? 1 : 0;
  return [seq, synthetic];
}

function compareTranscriptOrderKeys(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] - right[0] || left[1] - right[1];
}

/**
 * Printable rows in their append-only scrollback order.
 *
 * Source-backed rows use the durable order in which they became immutable.
 * Synthetic rows retain the settlement cursor captured when the CLI appended
 * them, with their original array position as the final stable tie-breaker.
 * Consumers that place rows relative to `<Static>` output must use this same
 * order rather than the stream's mutable storage order.
 *
 * Runs on every stream-sync tick, and entries arrive in settlement order on
 * all but the rare reorder — so it skips the O(n log n) sort whenever the
 * filtered slice is already ordered, at the cost of one O(n) pass over it.
 */
export function orderedStaticTranscriptEntries(
  entries: readonly ConversationEntry[],
  status: StreamPhase | undefined,
): readonly ConversationEntry[] {
  const candidates: Array<{
    entry: ConversationEntry;
    index: number;
    key: readonly [number, number];
  }> = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.role === 'activity' && !entry.finalized) break;
    if (!isStaticTranscriptEntryAt(entries, index, status)) continue;
    candidates.push({ entry, index, key: transcriptOrderKey(entry, index) });
  }

  const alreadyOrdered = candidates.every(
    (candidate, i) =>
      i === 0 ||
      compareTranscriptOrderKeys(candidates[i - 1]!.key, candidate.key) <= 0,
  );
  const ordered = alreadyOrdered
    ? candidates
    : candidates.toSorted(
        (left, right) =>
          compareTranscriptOrderKeys(left.key, right.key) ||
          left.index - right.index,
      );

  return ordered.map(({ entry }) => entry);
}

export function splitTranscriptEntries(
  entries: readonly ConversationEntry[],
  status: StreamPhase | undefined,
): {
  readonly finalized: ConversationEntry[];
  /** Non-finalized entries in original stream order. The renderer must
   *  walk this list (rather than rendering tool rows and the live
   *  assistant as separate buckets) so that text emitted before a tool
   *  call appears above the tool row instead of below it. Tool entries
   *  defer finalization until the stream itself finalizes — promoting
   *  them earlier would let a fast tool jump ahead of still-streaming
   *  assistant text in `<Static>` scrollback, where insertion order is
   *  fixed. */
  readonly pending: ConversationEntry[];
} {
  const showLiveAssistant = isActivePhase(status);
  const finalized: ConversationEntry[] = [];
  const pending: ConversationEntry[] = [];
  let canPromoteToStatic = true;
  for (const [index, entry] of entries.entries()) {
    if (entry.role === 'activity' && !entry.finalized) {
      canPromoteToStatic = false;
    }
    if (!isRenderableTranscriptEntry(entry)) continue;
    if (userPromptAwaitsLiveContinuation(entries, index, status)) {
      pending.push(entry);
      continue;
    }
    if (entry.finalized) {
      (canPromoteToStatic ? finalized : pending).push(entry);
      continue;
    }
    if (
      entry.role === 'activity' ||
      entry.role === 'tool' ||
      entry.role === 'workflowTask'
    ) {
      pending.push(entry);
      continue;
    }
    if (entry.role === 'assistant' && showLiveAssistant) {
      pending.push(entry);
    }
  }
  return { finalized, pending };
}
