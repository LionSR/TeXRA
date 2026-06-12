import {
  ANSI_ESCAPE_START,
  ansiEscapeEnd,
  stripAnsiSequences,
} from '@cli/runtime/ansiEscapes';
import {
  LIVE_ELAPSED_STREAM_STATUSES,
  type StreamStatus,
} from '@shared/schemas';

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
  for (const char of stripAnsiSequences(text)) {
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
    if (newline?.[0]) {
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
    case 'assistant':
    case 'error':
    case 'user':
      return terminalVisibleTranscriptText(entry.text).trim().length > 0;
    case 'process':
      return entry.process !== undefined;
    case 'tool':
      return entry.toolUse !== undefined;
  }
}

export function nextRenderableTranscriptEntry(
  entries: readonly ConversationEntry[],
  index: number,
): ConversationEntry | undefined {
  for (let i = index + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry && isRenderableTranscriptEntry(entry)) return entry;
  }
  return undefined;
}

export function userPromptAwaitsLiveContinuation(
  entries: readonly ConversationEntry[],
  index: number,
  status: StreamStatus | undefined,
): boolean {
  const entry = entries[index];
  if (
    entry?.role !== 'user' ||
    isInquiryContinuationText(entry.text) ||
    !isRenderableTranscriptEntry(entry) ||
    status === undefined ||
    !LIVE_ELAPSED_STREAM_STATUSES.has(status)
  ) {
    return false;
  }
  const nextEntry = nextRenderableTranscriptEntry(entries, index);
  return nextEntry === undefined;
}

export function splitTranscriptEntries(
  entries: readonly ConversationEntry[],
  status: StreamStatus | undefined,
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
  const showLiveAssistant =
    status !== undefined && LIVE_ELAPSED_STREAM_STATUSES.has(status);
  const finalized: ConversationEntry[] = [];
  const pending: ConversationEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    if (userPromptAwaitsLiveContinuation(entries, index, status)) {
      pending.push(entry);
      continue;
    }
    if (entry.finalized) {
      finalized.push(entry);
      continue;
    }
    if (entry.role === 'tool') {
      pending.push(entry);
      continue;
    }
    if (entry.role === 'process') {
      finalized.push(entry);
      continue;
    }
    if (entry.role === 'assistant' && showLiveAssistant) {
      pending.push(entry);
    }
  }
  return { finalized, pending };
}
