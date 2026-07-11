/**
 * TexraTranscriptRecorder — subscribes to an AgentTrace and translates each
 * AgentEvent into the StreamLogStore append/update calls that drive the
 * webview transcript.
 *
 * This is the host-product layer the SDK proposal calls for: the trace
 * channel itself is platform-neutral, and TeXRA's transcript persistence is
 * one of many possible subscribers.
 *
 * Streaming behavior mirrors the `AgentTrace` stream pattern:
 *   - stream.start creates the entry (empty text, status running) — it marks
 *     the moment the phase began, so consumers can surface liveness from it
 *   - the first content chunk flushes immediately; later chunks are
 *     buffered + flushed on an interval
 *   - finalize flushes any pending chunks immediately
 */
import type {
  AgentEvent,
  AgentTrace,
  AgentTraceSubscriber,
  LogEvent,
} from '@agent/trace';
import { computeUtilizationPercent } from '@agent/modelHandlers/support/contextUtilization';
import { isDebugModeEnabled } from '@logger/logUtils';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type LogLevel,
  type MessageType,
  type StreamTabId,
  type ToolUseLog,
} from '@shared/schemas';
import { generateShortId } from '@utils/core';

import { type StreamLogStore } from './StreamLogStore';

const STREAM_UPDATE_THROTTLE_MS = 50;

const KNOWN_MESSAGE_TYPES = new Set<string>(Object.values(MESSAGE_TYPES));

/**
 * Coerce an arbitrary string to a `MessageType`. Unknown values (which an
 * agent-general SDK consumer can produce via `LogOptions.messageType`)
 * fall back to `DEFAULT` instead of corrupting the persisted entry.
 */
function asMessageType(candidate: string | undefined): MessageType {
  if (!candidate) return MESSAGE_TYPES.DEFAULT;
  return KNOWN_MESSAGE_TYPES.has(candidate)
    ? (candidate as MessageType)
    : MESSAGE_TYPES.DEFAULT;
}

function shouldEmit(level: LogLevel, messageType: MessageType): boolean {
  if (messageType === MESSAGE_TYPES.INTERNAL) return false;
  if (level !== 'debug') return true;
  return isDebugModeEnabled();
}

/**
 * Redact secrets from a tool's recorded input before it is persisted. The
 * set_api_key tool masks its own user-facing result, but tool.start/tool.end can
 * carry the raw input — which would write the cleartext provider key to the
 * on-disk transcript (and reload it via history/restorable state). Keep this in
 * sync with SetApiKeyTool.name; new secret-bearing tool inputs must extend this
 * guard.
 */
function redactToolInputForLog(toolName: string, input: unknown): unknown {
  if (
    toolName !== 'set_api_key' ||
    input === null ||
    typeof input !== 'object' ||
    !('key' in input)
  ) {
    return input;
  }
  return { ...input, key: '[redacted]' };
}

interface StreamSinkState {
  buffer: string;
  pending: string[];
  created: boolean;
  ended: boolean;
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
  // stage.start's `kind` lives only on that event — `store.update` at
  // stage.end replaces `data` wholesale (see StreamLog.update), so without
  // this the persisted GROUP_END row would forget whether the stage was the
  // root "Run:" stage or a nested round/phase/session. Replayed legacy traces
  // rely on that distinction to tell a root run's terminal status apart from
  // a round's (see toStreamLifecycleStatus in packages/trace-viewer).
  const stageKinds = new Map<string, 'run' | 'round' | 'phase' | 'session'>();
  // Id of the current model invocation's MODEL_RESPONSE stream entry, so a
  // subsequent `response.finalized` event (#7086) can upsert that entry's text
  // instead of appending a duplicate row. Set on `stream.start` for a
  // MODEL_RESPONSE stream, consumed (and cleared) by `response.finalized`, and
  // reset when the invocation proceeds to tool execution. A single tool-use
  // round stage can contain several model invocations, so the outer round
  // stage is too coarse to be the only reset boundary.
  let pendingModelResponseId: string | undefined;

  const flushStream = (state: StreamSinkState, id: string): void => {
    if (state.updateTimer) {
      clearTimeout(state.updateTimer);
      state.updateTimer = null;
    }
    const pendingText = state.pending.join('');
    if (state.pending.length > 0) {
      state.buffer += pendingText;
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
        data: { status: state.ended ? 'completed' : 'running' },
        verbose: isDebugModeEnabled(),
      });
      state.created = !!appended;
      if (!state.created) state.enabled = false;
      return;
    }

    if (!state.ended && pendingText.length > 0) {
      store.appendText(streamId, id, pendingText);
      return;
    }

    if (state.ended) {
      store.update(streamId, id, {
        text: state.buffer,
        data: { status: 'completed' },
      });
    }
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

  // Append a generic text LOG row. Centralizes the boilerplate shared by the
  // log / usage / context.state / domain arms (nanoid id, LOG type, timestamp,
  // info level, debug-gated verbosity).
  const appendLog = (params: {
    level?: LogLevel;
    groupId: string | undefined;
    messageType: MessageType;
    text: string;
    data?: unknown;
    verbose?: boolean;
  }): void => {
    store.append(streamId, {
      id: generateShortId(),
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: params.level ?? 'info',
      timestamp: Date.now(),
      groupId: params.groupId,
      messageType: params.messageType,
      text: params.text,
      data: params.data,
      verbose: params.verbose ?? isDebugModeEnabled(),
    });
  };

  const handleLog = (event: LogEvent): void => {
    const messageType = asMessageType(event.messageType);
    if (!shouldEmit(event.level, messageType)) return;
    appendLog({
      level: event.level,
      groupId: event.stageId,
      messageType,
      text: event.message,
      data: event.data,
      verbose: event.verbose,
    });
  };

  const subscriber: AgentTraceSubscriber = (event: AgentEvent) => {
    switch (event.type) {
      case 'log':
        handleLog(event);
        return;

      case 'stage.start':
        if (event.kind) stageKinds.set(event.id, event.kind);
        // A new round starts fresh: whatever MODEL_RESPONSE stream the
        // previous round may have opened is no longer this round's to reuse.
        if (event.kind === 'round') pendingModelResponseId = undefined;
        store.append(streamId, {
          id: event.id,
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          level: 'info',
          timestamp: Date.now(),
          groupId: event.parentId,
          messageType: MESSAGE_TYPES.DEFAULT,
          text: event.label,
          data: {
            status: STREAM_PHASE.RUNNING,
            ...(event.kind ? { kind: event.kind } : {}),
            ...(event.index !== undefined ? { index: event.index } : {}),
            ...(event.total !== undefined ? { total: event.total } : {}),
          },
          verbose: isDebugModeEnabled(),
        });
        return;

      case 'stage.end': {
        const kind = stageKinds.get(event.id);
        stageKinds.delete(event.id);
        store.update(streamId, event.id, {
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          data: {
            status: event.status ?? RUN_OUTCOME.COMPLETED,
            endTime: Date.now(),
            ...(kind ? { kind } : {}),
          },
        });
        return;
      }

      case 'tool.start':
        pendingModelResponseId = undefined;
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
            input: redactToolInputForLog(event.toolName, event.input),
            status: 'in_progress',
          } satisfies ToolUseLog,
          verbose: isDebugModeEnabled(),
        });
        return;

      case 'tool.end': {
        const result = (event.result ?? {}) as Partial<ToolUseLog>;
        const redactedResult =
          typeof result.toolName === 'string'
            ? {
                ...result,
                input: redactToolInputForLog(result.toolName, result.input),
              }
            : result;
        // Omit groupId on update — undefined would clobber the canonical
        // value stamped at tool.start (deferred tools never copy the
        // resolved id back into their ref).
        store.update(streamId, event.logId, {
          messageType: MESSAGE_TYPES.TOOL_USE,
          data: {
            ...redactedResult,
            status: event.status,
          } as ToolUseLog,
        });
        return;
      }

      case 'usage':
        if (event.recordTranscript === false) return;
        appendLog({
          groupId: event.stageId,
          messageType: MESSAGE_TYPES.STATISTICS,
          text: `Usage - input: ${event.stats.inputTokens ?? 0}, output: ${event.stats.outputTokens ?? 0}`,
          data: event.stats,
        });
        return;

      case 'status':
        return;

      case 'context.state': {
        const utilizationPercent = computeUtilizationPercent(
          event.inputTokens,
          event.contextWindow,
        );
        appendLog({
          groupId: event.stageId,
          messageType: MESSAGE_TYPES.CONTEXT_STATE,
          text: `Context: ${event.inputTokens}/${event.contextWindow} tokens (${utilizationPercent.toFixed(1)}%)`,
          data: {
            inputTokens: event.inputTokens,
            contextWindow: event.contextWindow,
            utilizationPercent,
          },
        });
        return;
      }

      case 'stream.start': {
        const state: StreamSinkState = {
          buffer: '',
          pending: [],
          created: false,
          ended: false,
          enabled: true,
          groupId: event.stageId,
          level: 'info',
          messageType: asMessageType(event.kind),
          updateTimer: null,
        };
        streams.set(event.id, state);
        if (state.messageType === MESSAGE_TYPES.MODEL_RESPONSE) {
          pendingModelResponseId = event.id;
        }
        // The start IS the signal consumers care about — it marks the moment
        // the phase began: a running THINKING entry drives the CLI's "model
        // is thinking" indicator, and a running MODEL_RESPONSE entry says
        // the response has started even when its content is withheld
        // (phase-only workflow streams, hidden reasoning that never emits a
        // chunk). Materialize the entry immediately; renderers already skip
        // entries with empty text.
        flushStream(state, event.id);
        return;
      }

      case 'stream.chunk': {
        const state = streams.get(event.id);
        if (!state || !state.enabled) return;
        state.pending.push(event.text);
        // First content flushes immediately — the entry was materialized
        // empty at stream.start, so without this the first paint would wait
        // out the coalescing interval. Later chunks coalesce.
        if (!state.created || state.buffer.length === 0) {
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
        state.ended = true;
        flushStream(state, event.id);
        streams.delete(event.id);
        return;
      }

      case 'response.finalized': {
        if (!event.text) return;
        // Upsert by id, not by text: if this round's own MODEL_RESPONSE
        // stream already wrote a (possibly raw, pre-replacement) entry,
        // reconcile it to the authoritative text; otherwise this round never
        // streamed (e.g. a non-streaming provider call), so append it fresh.
        const correlatorId = pendingModelResponseId;
        pendingModelResponseId = undefined;
        if (correlatorId) {
          store.update(streamId, correlatorId, {
            text: event.text,
            data: { status: 'completed' },
          });
          return;
        }
        appendLog({
          groupId: event.stageId,
          messageType: MESSAGE_TYPES.MODEL_RESPONSE,
          text: event.text,
        });
        return;
      }

      case 'domain': {
        // Subscribers that care about specific keys can switch on event.key.
        // filesLoaded has a richer payload shape; format the text accordingly.
        if (event.key === 'filesLoaded') {
          const payload = event.data as
            | { category?: string; entries?: ReadonlyArray<{ ok?: boolean }> }
            | undefined;
          const entries = payload?.entries ?? [];
          const okCount = entries.filter((e) => e?.ok).length;
          appendLog({
            groupId: event.stageId,
            messageType: MESSAGE_TYPES.FILE_LIST,
            text: `Loading ${payload?.category ?? ''} (${okCount}/${entries.length})`,
            data: entries,
          });
          return;
        }
        appendLog({
          groupId: event.stageId,
          messageType: DOMAIN_MESSAGE_TYPE[event.key] ?? MESSAGE_TYPES.DEFAULT,
          text: event.text ?? event.key,
          data: event.data,
        });
        return;
      }

      case 'conversation.progress':
      case 'updateTodos':
      case 'updatePlan':
      case 'addOutputFiles':
      case 'updateMissingOutputs':
      case 'updateCompileFailures':
      case 'goalPaused':
        return;

      case 'result':
        // The terminal outcome is consumed by hosts via `session.onResult`.
        // The transcript already reflects completion through `stage.end`, so it
        // adds no row here (keeps transcript output unchanged).
        return;

      case 'run.start':
      case 'run.config':
        // Run identity/config facts drive host state through the session plane.
        // They are not transcript rows.
        return;

      case 'child.activity':
      case 'process.output':
        // Stage 3a child/process facts replace legacy progress events for UI
        // badges and process panes; they were not transcript rows before.
        return;

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
 * Maps a domain key onto a known MessageType; keys not listed fall back to the
 * DEFAULT bucket. Renderers that key on messageType (latexdiff, scratchpad,
 * missingOutputs) keep working without subscriber changes.
 */
const DOMAIN_MESSAGE_TYPE: Record<string, MessageType> = {
  latexdiff: MESSAGE_TYPES.LATEXDIFF,
  scratchpad: MESSAGE_TYPES.SCRATCHPAD,
  missingOutputs: MESSAGE_TYPES.MISSING_OUTPUTS,
  webSearch: MESSAGE_TYPES.WEB_SEARCH,
  webFetch: MESSAGE_TYPES.WEB_FETCH,
  contextManagement: MESSAGE_TYPES.CONTEXT_MANAGEMENT,
};
