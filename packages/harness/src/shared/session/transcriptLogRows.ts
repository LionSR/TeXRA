/**
 * The `log` transcript rows: a `log` row carries a payload keyed by a
 * message type, decoded here exactly once (`decodeLogPayload`). A payload
 * its schema rejects is written as an error row naming the diagnostic, never
 * dropped or cast.
 */

import {
  MESSAGE_TYPES,
  decodeLogPayload,
  type MessageType,
  type TranscriptEvent,
} from '@shared/schemas';
import type { StreamingTextRow } from '@shared/transcript';

import { open, write, type Draft } from './transcriptState';

/** The three message types whose payload is streaming markdown text. */
export const STREAMING_TEXT_ROW_KIND: Partial<
  Record<MessageType, StreamingTextRow['kind']>
> = {
  [MESSAGE_TYPES.MODEL_RESPONSE]: 'assistant',
  [MESSAGE_TYPES.THINKING]: 'thinking',
  [MESSAGE_TYPES.SCRATCHPAD]: 'scratchpad',
};

/** One `log` event onto the transcript: its payload decoded once, and a
 *  payload its schema rejects written as an error row naming the
 *  diagnostic, never dropped. */
export function recordLogRow(
  d: Draft,
  event: Extract<TranscriptEvent, { type: 'log' }>,
): void {
  if (event.level === 'debug' && !d.ctx.debug) return;
  const groupId = event.stageId;
  const messageType = event.messageType ?? MESSAGE_TYPES.DEFAULT;
  const text = event.message;
  const decoded = decodeLogPayload(messageType, event.data);
  if ('issue' in decoded) {
    write(d, {
      kind: 'log',
      base: open(d, d.stampId, groupId, MESSAGE_TYPES.ERROR, true, 'error'),
      text: `Malformed ${messageType} payload`,
      payload: {
        messageType: MESSAGE_TYPES.ERROR,
        data: { message: decoded.issue, userRetryable: false },
      },
    });
    return;
  }
  const base = open(d, d.stampId, groupId, messageType, true, event.level);
  const { payload } = decoded;
  switch (payload.messageType) {
    case MESSAGE_TYPES.MODEL_RESPONSE:
    case MESSAGE_TYPES.THINKING:
    case MESSAGE_TYPES.SCRATCHPAD:
      write(d, {
        kind: 'text',
        base,
        rowKind: STREAMING_TEXT_ROW_KIND[payload.messageType],
        text,
        running: payload.data?.status === 'running',
      });
      return;
    case MESSAGE_TYPES.TOOL_USE:
      write(d, { kind: 'tool', base, log: payload.data, call: {} });
      return;
    case MESSAGE_TYPES.USER_MESSAGE: {
      // The first message a park was followed by is where "Fork from here"
      // cuts; the rest of a batch taken at that park share its cut, so only
      // the first offers it, and the first message of all cuts before
      // nothing.
      const forkAt = d.ix.seenUserMessage ? d.ix.lastPark : null;
      d.ix.seenUserMessage = true;
      d.ix.lastPark = null;
      write(d, {
        kind: 'log',
        base,
        text,
        payload,
        ...(forkAt === null ? {} : { forkAt }),
      });
      return;
    }
    default:
      write(d, { kind: 'log', base, text, payload });
  }
}
