/**
 * TexraTranscriptRecorder — subscribes to an AgentTrace and translates each
 * AgentEvent into the StreamLogStore append/update calls that drive the
 * webview transcript.
 *
 * This is the host-product layer the SDK proposal calls for: the trace
 * channel itself is platform-neutral, and TeXRA's transcript persistence is
 * one of many possible subscribers.
 *
 * Streaming behavior mirrors the legacy `AgentLogger.createStream`:
 *   - first chunk creates the entry (with empty text if no chunks yet)
 *   - subsequent chunks are buffered + flushed on an interval
 *   - finalize flushes any pending chunks immediately
 */
import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AgentTrace,
  AgentTraceSubscriber,
  LogEvent,
} from '@agent/trace';
import {
  END_GROUP_STATUS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type LogLevel,
  type MessageType,
  type StreamLogEntry,
  type StreamTabId,
  type ToolUseLog,
} from '@shared/schemas';
import { getConfig } from '@utils/config';


import { type StreamLogStore } from './StreamLogStore';

const STREAM_UPDATE_THROTTLE_MS = 50;

function shouldEmit(level: LogLevel, messageType: MessageType): boolean {
  if (messageType === MESSAGE_TYPES.INTERNAL) return false;
  if (level !== 'debug') return true;
  return getConfig<boolean>('texra.logger.debugMode', false);
}

function debugModeEnabled(): boolean {
  return getConfig<boolean>('texra.logger.debugMode', false);
}

interface StreamSinkState {
  buffer: string;
  pending: string[];
  created: boolean;
  enabled: boolean;
  groupId: string | undefined;
  level: LogLevel;
  messageType: MessageType;
  updateTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Subscribe to a trace and route every event into the StreamLogStore for the
 * given streamId. Returns an `unsubscribe()` plus a `flushPending()` used by
 * shutdown paths to drain in-flight streaming buffers.
 */
export interface TranscriptRecorderHandle {
  unsubscribe(): void;
  flushPending(): void;
}

export function attachTranscriptRecorder(
  trace: AgentTrace,
  streamId: StreamTabId,
  store: StreamLogStore,
): TranscriptRecorderHandle {
  const streams = new Map<string, StreamSinkState>();

  const flushStream = (state: StreamSinkState, id: string): void => {
    if (state.updateTimer) {
      clearTimeout(state.updateTimer);
      state.updateTimer = null;
    }
    if (state.pending.length > 0) {
      state.buffer += state.pending.join('');
      state.pending = [];
    }
    if (!state.enabled) return;

    if (!state.created) {
      const appended = store.append(streamId, {
        id,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: state.level,
        timestamp: Date.now(),
        groupId: state.groupId,
        messageType: state.messageType,
        text: state.buffer,
        verbose: debugModeEnabled(),
      });
      state.created = !!appended;
      if (!state.created) state.enabled = false;
      return;
    }

    store.update(streamId, id, { text: state.buffer });
  };

  const scheduleStreamUpdate = (state: StreamSinkState, id: string): void => {
    if (state.updateTimer) return;
    state.updateTimer = setTimeout(() => {
      state.updateTimer = null;
      flushStream(state, id);
    }, STREAM_UPDATE_THROTTLE_MS);
  };

  const flushPending = (): void => {
    for (const [id, state] of streams) flushStream(state, id);
  };

  const handleLog = (event: LogEvent): void => {
    const messageType = event.messageType ?? MESSAGE_TYPES.DEFAULT;
    if (!shouldEmit(event.level, messageType)) return;

    store.append(streamId, {
      id: randomUUID(),
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: event.level,
      timestamp: Date.now(),
      groupId: event.stageId,
      messageType,
      text: event.message,
      data: event.data,
      verbose: event.verbose ?? debugModeEnabled(),
    });
  };

  const subscriber: AgentTraceSubscriber = (event: AgentEvent) => {
    switch (event.type) {
      case 'log':
        handleLog(event);
        return;

      case 'stage.start':
        store.append(streamId, {
          id: event.id,
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          level: 'info',
          timestamp: Date.now(),
          groupId: event.parentId,
          messageType: MESSAGE_TYPES.DEFAULT,
          text: event.label,
          data: { status: 'running' },
          verbose: debugModeEnabled(),
        });
        return;

      case 'stage.end':
        store.update(streamId, event.id, {
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          data: {
            status: event.status ?? END_GROUP_STATUS.STOPPED,
            endTime: Date.now(),
          },
        });
        return;

      case 'tool.start':
        // event.logId is the canonical id — SDK consumers correlate
        // tool.start/end by it and the store entry shares the same id so
        // callers can lookup with store.get(streamId).find(e => e.id === logId).
        store.append(streamId, {
          id: event.logId,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: 'info',
          timestamp: Date.now(),
          groupId: event.stageId,
          messageType: MESSAGE_TYPES.TOOL_USE,
          data: {
            toolName: event.toolName,
            input: event.input,
            status: 'in_progress',
          } satisfies ToolUseLog,
          verbose: debugModeEnabled(),
        });
        return;

      case 'tool.end': {
        const result = (event.result ?? {}) as Partial<ToolUseLog>;
        // Omit groupId on update — undefined would clobber the canonical
        // value stamped at tool.start (deferred tools never copy the
        // resolved id back into their ref).
        store.update(streamId, event.logId, {
          messageType: MESSAGE_TYPES.TOOL_USE,
          data: {
            ...result,
            status: event.status,
          } as ToolUseLog,
        });
        return;
      }

      case 'usage':
        store.append(streamId, {
          id: randomUUID(),
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: 'info',
          timestamp: Date.now(),
          groupId: event.stageId,
          messageType: MESSAGE_TYPES.STATISTICS,
          text: `Usage - input: ${event.stats.inputTokens ?? 0}, output: ${event.stats.outputTokens ?? 0}`,
          data: event.stats,
          verbose: debugModeEnabled(),
        });
        return;

      case 'context.state': {
        const utilizationPercent =
          (event.inputTokens / event.contextWindow) * 100;
        store.append(streamId, {
          id: randomUUID(),
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: 'info',
          timestamp: Date.now(),
          groupId: event.stageId,
          messageType: MESSAGE_TYPES.CONTEXT_STATE,
          text: `Context: ${event.inputTokens}/${event.contextWindow} tokens (${utilizationPercent.toFixed(1)}%)`,
          data: {
            inputTokens: event.inputTokens,
            contextWindow: event.contextWindow,
            utilizationPercent,
          },
          verbose: debugModeEnabled(),
        });
        return;
      }

      case 'files.loaded': {
        const okCount = event.entries.filter((e) => e.ok).length;
        store.append(streamId, {
          id: randomUUID(),
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: 'info',
          timestamp: Date.now(),
          groupId: event.stageId,
          messageType: MESSAGE_TYPES.FILE_LIST,
          text: `Loading ${event.category} (${okCount}/${event.entries.length})`,
          data: event.entries,
          verbose: debugModeEnabled(),
        });
        return;
      }

      case 'stream.start':
        streams.set(event.id, {
          buffer: '',
          pending: [],
          created: false,
          enabled: true,
          groupId: event.stageId,
          level: 'info',
          messageType: event.kind,
          updateTimer: null,
        });
        return;

      case 'stream.chunk': {
        const state = streams.get(event.id);
        if (!state || !state.enabled) return;
        state.pending.push(event.text);
        if (!state.created) {
          flushStream(state, event.id);
        } else {
          scheduleStreamUpdate(state, event.id);
        }
        return;
      }

      case 'stream.end': {
        const state = streams.get(event.id);
        if (!state) return;
        if (typeof event.finalText === 'string') {
          state.buffer = event.finalText;
          state.pending = [];
        }
        flushStream(state, event.id);
        streams.delete(event.id);
        return;
      }

      case 'domain': {
        // Domain events render as text + data with a synthetic messageType.
        // Subscribers that care about specific keys can switch on event.key.
        store.append(streamId, {
          id: randomUUID(),
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: 'info',
          timestamp: Date.now(),
          groupId: event.stageId,
          messageType: domainMessageType(event.key),
          text: event.text ?? event.key,
          data: event.data,
          verbose: debugModeEnabled(),
        });
        return;
      }

      default: {
        // Exhaustiveness check: adding a new event arm forces an error here.
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  };

  const unsubscribe = trace.subscribe(subscriber);
  return {
    unsubscribe: () => {
      flushPending();
      unsubscribe();
    },
    flushPending,
  };
}

/**
 * Map a domain key onto a known MessageType when applicable; otherwise use
 * the DEFAULT bucket. Renderers that key on messageType (latexdiff,
 * scratchpad, missingOutputs) keep working without subscriber changes.
 */
function domainMessageType(key: string): MessageType {
  switch (key) {
    case 'latexdiff':
      return MESSAGE_TYPES.LATEXDIFF;
    case 'scratchpad':
      return MESSAGE_TYPES.SCRATCHPAD;
    case 'missingOutputs':
      return MESSAGE_TYPES.MISSING_OUTPUTS;
    case 'webSearch':
      return MESSAGE_TYPES.WEB_SEARCH;
    case 'webFetch':
      return MESSAGE_TYPES.WEB_FETCH;
    case 'contextManagement':
      return MESSAGE_TYPES.CONTEXT_MANAGEMENT;
    case 'progressStatus':
      return MESSAGE_TYPES.PROGRESS_STATUS;
    case 'userMessage':
      return MESSAGE_TYPES.USER_MESSAGE;
    default:
      return MESSAGE_TYPES.DEFAULT;
  }
}

/** Re-exported so SDK consumers can introspect the persisted shape. */
export type { StreamLogEntry };
