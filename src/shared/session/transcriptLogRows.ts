/**
 * The `log`-shaped transcript rows: a `log` row, a `usage` row, and a
 * `domain` row each carry a payload keyed by a message type, decoded here
 * exactly once (`decodeLogPayload`). A payload its schema rejects is written
 * as an error row naming the diagnostic, never dropped or cast.
 */
import {
  MESSAGE_TYPES,
  decodeLogPayload,
  type LogLevel,
  type MessageType,
  type TranscriptEvent,
} from '@shared/schemas';
import type { StreamingTextRow } from '@ui/transcript';
import { isObject } from '@utils/core';

import { open, write, type Draft } from './transcriptState';

const KNOWN_MESSAGE_TYPES = new Set<string>(Object.values(MESSAGE_TYPES));

/**
 * Coerce an arbitrary string to a `MessageType`. Unknown values (which an
 * agent-general SDK consumer can produce via `LogOptions.messageType`) fall
 * back to `DEFAULT`.
 */
export function asMessageType(candidate: string | undefined): MessageType {
  if (!candidate) return MESSAGE_TYPES.DEFAULT;
  return KNOWN_MESSAGE_TYPES.has(candidate)
    ? (candidate as MessageType)
    : MESSAGE_TYPES.DEFAULT;
}

/** The three message types whose payload is streaming markdown text. */
export const STREAMING_TEXT_ROW_KIND: Partial<
  Record<MessageType, StreamingTextRow['kind']>
> = {
  [MESSAGE_TYPES.MODEL_RESPONSE]: 'assistant',
  [MESSAGE_TYPES.THINKING]: 'thinking',
  [MESSAGE_TYPES.SCRATCHPAD]: 'scratchpad',
};

/**
 * Maps a domain key onto a known MessageType; keys not listed fall back to the
 * DEFAULT bucket.
 */
const DOMAIN_MESSAGE_TYPE: Record<string, MessageType> = {
  latexdiff: MESSAGE_TYPES.LATEXDIFF,
  scratchpad: MESSAGE_TYPES.SCRATCHPAD,
  missingOutputs: MESSAGE_TYPES.MISSING_OUTPUTS,
  webSearch: MESSAGE_TYPES.WEB_SEARCH,
  contextManagement: MESSAGE_TYPES.CONTEXT_MANAGEMENT,
};

/** A `log`-shaped row: its payload decoded once, and a payload its schema
 *  rejects written as an error row naming the diagnostic, never dropped. */
function appendLog(
  d: Draft,
  groupId: string | undefined,
  messageType: MessageType,
  text: string,
  data: unknown,
  level: LogLevel = 'info',
  verbose: boolean = d.ctx.debug,
): void {
  const decoded = decodeLogPayload(messageType, data);
  if ('issue' in decoded) {
    write(d, {
      kind: 'log',
      base: open(
        d,
        d.stampId,
        groupId,
        MESSAGE_TYPES.ERROR,
        true,
        'error',
        verbose,
      ),
      text: `Malformed ${messageType} payload`,
      payload: {
        messageType: MESSAGE_TYPES.ERROR,
        data: { message: decoded.issue, userRetryable: false },
      },
    });
    return;
  }
  const base = open(d, d.stampId, groupId, messageType, true, level, verbose);
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
      write(d, { kind: 'tool', base, log: payload.data });
      return;
    case MESSAGE_TYPES.WORKFLOW_TASK:
      write(d, { kind: 'call', base, call: payload.data });
      return;
    default:
      write(d, { kind: 'log', base, text, payload });
  }
}

/** One `log`, `usage`, or `domain` event onto the transcript. */
export function recordLogRow(
  d: Draft,
  event: Extract<TranscriptEvent, { type: 'log' | 'usage' | 'domain' }>,
): void {
  switch (event.type) {
    case 'log': {
      const messageType = asMessageType(event.messageType);
      if (
        messageType === MESSAGE_TYPES.INTERNAL ||
        (event.level === 'debug' && !d.ctx.debug)
      )
        return;
      appendLog(
        d,
        event.stageId,
        messageType,
        event.message,
        event.data,
        event.level,
        event.verbose,
      );
      return;
    }

    case 'usage':
      if (event.recordTranscript === false) return;
      appendLog(d, event.stageId, MESSAGE_TYPES.STATISTICS, '', event.usage);
      return;

    case 'domain': {
      // A retry lifecycle is a durable marker nothing renders.
      if (event.key === 'modelRetryLifecycle') {
        appendLog(
          d,
          event.stageId,
          MESSAGE_TYPES.INTERNAL,
          '',
          event.data,
          'info',
          false,
        );
        return;
      }
      if (event.key === 'filesLoaded') {
        const payload = isObject(event.data) ? event.data : {};
        appendLog(
          d,
          event.stageId,
          MESSAGE_TYPES.FILE_LIST,
          '',
          payload.entries ?? [],
        );
        return;
      }
      appendLog(
        d,
        event.stageId,
        DOMAIN_MESSAGE_TYPE[event.key] ?? MESSAGE_TYPES.DEFAULT,
        event.text ?? event.key,
        event.data,
      );
      return;
    }
  }
}
