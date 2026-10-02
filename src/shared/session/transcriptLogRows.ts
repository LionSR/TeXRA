/**
 * The `log`-shaped transcript rows: a `log` row and a `usage` row each carry
 * a payload keyed by a message type, decoded here
 * exactly once (`decodeLogPayload`). A payload its schema rejects is written
 * as an error row naming the diagnostic, never dropped or cast.
 */

import {
  MESSAGE_TYPES,
  addTurnTotals,
  runStatistics,
  decodeLogPayload,
  type LogLevel,
  type MessageType,
  type TranscriptEvent,
} from '@shared/schemas';
import { modelConfig } from '@shared/model/modelSelection';
import type { StreamingTextRow } from '@ui/transcript';

import { open, write, type Draft } from './transcriptState';

/** The three message types whose payload is streaming markdown text. */
export const STREAMING_TEXT_ROW_KIND: Partial<
  Record<MessageType, StreamingTextRow['kind']>
> = {
  [MESSAGE_TYPES.MODEL_RESPONSE]: 'assistant',
  [MESSAGE_TYPES.THINKING]: 'thinking',
  [MESSAGE_TYPES.SCRATCHPAD]: 'scratchpad',
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
): void {
  const decoded = decodeLogPayload(messageType, data);
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
  const base = open(d, d.stampId, groupId, messageType, true, level);
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
    default:
      write(d, { kind: 'log', base, text, payload });
  }
}

/** One `log` or `usage` event onto the transcript. */
export function recordLogRow(
  d: Draft,
  event: Extract<TranscriptEvent, { type: 'log' | 'usage' }>,
): void {
  switch (event.type) {
    case 'log': {
      if (event.level === 'debug' && !d.ctx.debug) return;
      appendLog(
        d,
        event.stageId,
        event.messageType ?? MESSAGE_TYPES.DEFAULT,
        event.message,
        event.data,
        event.level,
      );
      return;
    }

    case 'usage': {
      // A priced turn shows as a workflow run's statistics so far; other
      // runs show none.
      const statistics = d.ctx.statistics;
      if (statistics === undefined) return;
      d.ix.spend = addTurnTotals(d.ix.spend, event.usage);
      const id = d.ix.model ?? statistics.model;
      const model = id == null ? undefined : modelConfig(id);
      appendLog(
        d,
        d.ix.runStage,
        MESSAGE_TYPES.STATISTICS,
        '',
        runStatistics(
          d.ix.spend,
          model && {
            ...model.capabilities,
            supportsReasoning: model.reasoning !== undefined,
          },
        ),
      );
      return;
    }
  }
}
