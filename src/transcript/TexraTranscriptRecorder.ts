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
 *
 * Secret redaction happens here, at record time. Every text row this recorder
 * persists passes through `redactSecrets`, along with the diagnostic strings a
 * host renders beside a row (an error's `data.message`, a failed workflow
 * call's `error`), so the property holds once for the extension, desktop and
 * CLI transcripts, for resumed replays, and for the shareable HTML export,
 * instead of each renderer re-deriving it. Tool inputs and results are the
 * deliberate exception: they carry whole files and code, where blanket
 * redaction would corrupt more than it protects, so only known secret-bearing
 * inputs are scrubbed (see `redactToolInputForLog`).
 *
 * Redaction is lossy by construction: a literal `API_KEY=<value>` in a
 * model-written code sample is scrubbed along with a real key.
 */
import PQueue from 'p-queue';

import type {
  AgentEvent,
  AgentTrace,
  AgentTraceSubscriber,
  StatusEvent,
} from '@agent/trace';
import { roundedUtilizationPercent } from '@agent/modelHandlers/support/contextUtilization';
import { isDebugModeEnabled } from '@logger/logUtils';
import { redactSecrets } from '@logger/redaction';
import {
  ActiveSkillsSnapshotSchema,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  TOOL_USE_STATUS,
  isTerminalWorkflowCallProgress,
  type LogLevel,
  type MessageType,
  type ToolUseLog,
  type WorkflowAttemptMarker,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import {
  createFlushableDebounce,
  generateShortId,
  isObject,
  type FlushableDebounce,
} from '@utils/core';

import type { StreamLogAppendInput, StreamLogUpdatePatch } from './StreamLog';
import type { TranscriptWriter } from './StreamLogStore';

const STREAM_UPDATE_THROTTLE_MS = 50;
const MAX_TRANSCRIPT_ENTRY_BYTES = 50 * 1024;
const MAX_TRANSCRIPT_ENTRY_LINES = 2_000;
const TRANSCRIPT_PREVIEW_LINES = 40;
const TRANSCRIPT_TRUNCATION_MARKER =
  '\n\n… output truncated in transcript; retained in run artifacts …\n\n';
const LIVE_TOOL_TRUNCATION_MARKER =
  '\n\n… output truncated while the tool is running …\n\n';
const UTF8_ENCODER = new TextEncoder();

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
 * Redact secrets from a tool's recorded input before it is persisted.
 * Older sessions may replay `set_api_key` events whose tool.start/tool.end
 * payload carries the raw input. The tool is no longer registered, but this
 * redaction remains so imported or resumed history cannot write a legacy key
 * into the current transcript. New secret-bearing tool inputs must extend this
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

/**
 * An error row keeps its provider detail in `data.message` (ErrorLogData), and
 * every host renders that field next to the row text, so it needs the same
 * record-time redaction: a provider error body can echo the request URL or an
 * `Authorization` header.
 *
 * Only a plain payload is rebuilt. A caller may pass a raw `Error` as log data,
 * whose `message` and `stack` are non-enumerable own properties that a spread
 * would silently drop; such an object serializes to `{}` on the wire and on
 * disk anyway, so it is left untouched.
 */
function redactLogData(data: unknown): unknown {
  if (
    !isObject(data) ||
    Object.getPrototypeOf(data) !== Object.prototype ||
    typeof data.message !== 'string'
  ) {
    return data;
  }
  // Every string the hosts render beside an error row: rawMessage and
  // rawErrorBody carry provider error bodies (which can echo request URLs or
  // Authorization headers), partialText carries truncated model output.
  const redacted: Record<string, unknown> = { ...data };
  for (const key of [
    'message',
    'rawMessage',
    'rawErrorBody',
    'statusText',
    'partialText',
  ]) {
    if (typeof redacted[key] === 'string') {
      redacted[key] = redactSecrets(redacted[key] as string);
    }
  }
  return redacted;
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
  updateDebounce: FlushableDebounce;
}

/**
 * Subscribe to a trace and route every event into the StreamLogStore for the
 * given streamId. Returns an `unsubscribe()` plus a `flushPending()` used by
 * shutdown paths to drain in-flight streaming buffers.
 */
export interface TranscriptRecorderHandle {
  unsubscribe(): void;
  flushPending(): void;
  flushSpills(): Promise<void>;
  /**
   * Consume one canonical `status` session fact for this recorder's stream.
   * Status travels only on the session-fact rail (it is not an `AgentEvent`),
   * so the launch path bridges the session hub's status subscription into
   * this port — see `RunTrace.handleStatus`.
   */
  handleStatus(event: StatusEvent): void;
}

export interface TranscriptSpillWriter {
  readonly pathFor: (entryId: string) => string;
  write(path: string, content: string): Promise<void>;
}

function boundedTranscriptPreview(
  text: string,
  marker = TRANSCRIPT_TRUNCATION_MARKER,
): string {
  const lines = text.split('\n');
  if (
    UTF8_ENCODER.encode(text).length <= MAX_TRANSCRIPT_ENTRY_BYTES &&
    lines.length <= MAX_TRANSCRIPT_ENTRY_LINES
  ) {
    return text;
  }
  const contentBudget =
    MAX_TRANSCRIPT_ENTRY_BYTES - UTF8_ENCODER.encode(marker).length;
  const head = utf8Prefix(
    lines.slice(0, TRANSCRIPT_PREVIEW_LINES).join('\n'),
    Math.floor(contentBudget / 2),
  );
  const tail = utf8Suffix(
    lines.slice(-TRANSCRIPT_PREVIEW_LINES).join('\n'),
    Math.ceil(contentBudget / 2),
  );
  return `${head}${marker}${tail}`;
}

function utf8Prefix(text: string, byteBudget: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = utf8CharacterBytes(character);
    if (bytes + characterBytes > byteBudget) break;
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function utf8Suffix(text: string, byteBudget: number): string {
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    let characterStart = start - 1;
    const codeUnit = text.charCodeAt(characterStart);
    if (
      codeUnit >= 0xdc00 &&
      codeUnit <= 0xdfff &&
      characterStart > 0 &&
      text.charCodeAt(characterStart - 1) >= 0xd800 &&
      text.charCodeAt(characterStart - 1) <= 0xdbff
    ) {
      characterStart -= 1;
    }
    const character = text.slice(characterStart, start);
    const characterBytes = utf8CharacterBytes(character);
    if (bytes + characterBytes > byteBudget) break;
    bytes += characterBytes;
    start = characterStart;
  }
  return text.slice(start);
}

function utf8CharacterBytes(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function attachTranscriptRecorder(
  trace: AgentTrace,
  writer: TranscriptWriter,
  spillWriter?: TranscriptSpillWriter,
): TranscriptRecorderHandle {
  const { streamId } = writer;
  const streams = new Map<string, StreamSinkState>();
  let pendingFailure: unknown;
  let pendingSpillFailure: unknown;
  const pendingSpills = new Set<Promise<void>>();
  const spillQueues = new Map<string, PQueue>();
  const queueSpill = (
    id: string,
    text: string,
    preview: string,
  ): string | undefined => {
    if (preview === text || !spillWriter) return undefined;
    const path = spillWriter.pathFor(id);
    let queue = spillQueues.get(path);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      spillQueues.set(path, queue);
    }
    const pending = Promise.resolve(
      queue.add(() => spillWriter.write(path, text)),
    )
      .catch((error: unknown) => {
        pendingSpillFailure ??= error;
      })
      .finally(() => {
        pendingSpills.delete(pending);
        if (
          queue.pending === 0 &&
          queue.size === 0 &&
          spillQueues.get(path) === queue
        ) {
          spillQueues.delete(path);
        }
      });
    pendingSpills.add(pending);
    return path;
  };
  const boundToolOutput = (
    id: string,
    result: Partial<ToolUseLog>,
    persistSpill = true,
  ): ToolUseLog => {
    if (typeof result.output !== 'string') return result as ToolUseLog;
    const output = result.output;
    const preview = boundedTranscriptPreview(
      output,
      persistSpill ? TRANSCRIPT_TRUNCATION_MARKER : LIVE_TOOL_TRUNCATION_MARKER,
    );
    const spillPath = persistSpill
      ? queueSpill(id, output, preview)
      : undefined;
    return {
      ...result,
      output: preview,
      ...(spillPath && { spillPath }),
    } as ToolUseLog;
  };
  const boundModelResponse = (
    id: string,
    text: string,
  ): { text: string; data: Record<string, string> } => {
    const redacted = redactSecrets(text);
    const preview = boundedTranscriptPreview(redacted);
    const spillPath = queueSpill(id, redacted, preview);
    return {
      text: preview,
      data: { status: 'completed', ...(spillPath && { spillPath }) },
    };
  };
  const recordFailure = (error: unknown): void => {
    pendingFailure ??= error;
    for (const state of streams.values()) {
      state.updateDebounce.cancel();
      state.enabled = false;
    }
  };
  const activeStageIds = new Set<string>();
  const workflowCallEntries = new Set<string>();
  const activeToolEntries = new Map<string, ToolUseLog>();
  let transcriptBoundaryClosed = false;
  // Id of the current model invocation's MODEL_RESPONSE stream entry, so a
  // subsequent `response.finalized` event (#7086) can upsert that entry's text
  // instead of appending a duplicate row. Set on `stream.start` for a
  // MODEL_RESPONSE stream, consumed (and cleared) by `response.finalized`, and
  // reset when the invocation proceeds to tool execution. A single tool-use
  // session stage can contain several model invocations, so the outer stage is
  // too coarse to be the only reset boundary.
  let pendingModelResponseId: string | undefined;
  const detachedModelResponseIds = new Set<string>();

  const settlePendingModelResponse = (): void => {
    if (!pendingModelResponseId) return;
    const id = pendingModelResponseId;
    pendingModelResponseId = undefined;
    // An active stream remains mutable until stream.end materializes its final
    // text. Remember that it crossed the model/tool boundary so stream.end can
    // settle it even though it is no longer the current response correlator.
    if (streams.has(id)) detachedModelResponseIds.add(id);
    else writer.settle(id, {});
  };

  const flushStream = (state: StreamSinkState, id: string): void => {
    state.updateDebounce.cancel();
    const pendingText = state.pending.join('');
    if (state.pending.length > 0) {
      state.buffer += pendingText;
      state.pending = [];
    }
    if (!state.enabled) return;

    if (!state.created) {
      const entry = {
        id,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: state.level,
        timestamp: Date.now(),
        groupId: state.groupId,
        messageType: state.messageType,
        text: redactSecrets(state.buffer),
        data: { status: state.ended ? 'completed' : 'running' },
        verbose: isDebugModeEnabled(),
      } satisfies StreamLogAppendInput;
      if (state.ended && state.messageType !== MESSAGE_TYPES.MODEL_RESPONSE) {
        writer.appendSettled(entry);
      } else {
        writer.append(entry);
      }
      state.created = true;
      return;
    }

    if (!state.ended && pendingText.length > 0) {
      // Mid-stream deltas are redacted on their own: a secret split across two
      // provider chunks survives here, and the whole-buffer redaction below
      // scrubs it when the stream settles, which is the text that is persisted,
      // exported and replayed.
      writer.appendText(id, redactSecrets(pendingText));
      return;
    }

    if (state.ended) {
      const patch = boundModelResponse(id, state.buffer);
      if (state.messageType === MESSAGE_TYPES.MODEL_RESPONSE) {
        // The raw stream ends before response.finalized carries the
        // authoritative post-replacement text. Keep this row mutable until
        // that event reconciles and settles it.
        writer.update(id, patch);
      } else {
        writer.settle(id, patch);
      }
    }
  };

  const scheduleStreamUpdate = (state: StreamSinkState): void => {
    if (!state.updateDebounce.pending) state.updateDebounce.schedule();
  };

  const flushPending = (): void => {
    if (pendingFailure !== undefined) throw pendingFailure;
    try {
      for (const [id, state] of streams) flushStream(state, id);
    } catch (error) {
      recordFailure(error);
      throw error;
    }
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
    writer.appendSettled({
      id: generateShortId(),
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: params.level ?? 'info',
      timestamp: Date.now(),
      groupId: params.groupId,
      messageType: params.messageType,
      text: redactSecrets(params.text),
      data: redactLogData(params.data),
      verbose: params.verbose ?? isDebugModeEnabled(),
    });
  };

  const subscriber: AgentTraceSubscriber = (event: AgentEvent) => {
    if (pendingFailure !== undefined) throw pendingFailure;
    try {
      switch (event.type) {
        case 'log': {
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
          return;
        }

        case 'stage.start': {
          const metadata = {
            ...(event.kind !== undefined ? { kind: event.kind } : {}),
            ...(event.index !== undefined ? { index: event.index } : {}),
            ...(event.total !== undefined ? { total: event.total } : {}),
            ...(event.attemptId !== undefined
              ? { attemptId: event.attemptId }
              : {}),
          };
          activeStageIds.add(event.id);
          // A new model-turn boundary starts fresh: whatever MODEL_RESPONSE
          // stream the previous turn may have opened is no longer this turn's
          // to reuse. Tool-use turns are session stages containing several
          // inner model/tool rounds, while other flows expose round stages.
          if (event.kind === 'round' || event.kind === 'session') {
            settlePendingModelResponse();
          }
          writer.append({
            id: event.id,
            // Detached responses settle after this append but belong before
            // the new heading. Reserve their pending settlement slots so cold
            // replay preserves the live store order.
            presentationSeqNo:
              writer.settlementHead + detachedModelResponseIds.size,
            type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
            level: 'info',
            timestamp: Date.now(),
            groupId: event.parentId,
            messageType: MESSAGE_TYPES.DEFAULT,
            text: redactSecrets(event.label),
            data: {
              status: STREAM_PHASE.RUNNING,
              ...metadata,
            },
            verbose: isDebugModeEnabled(),
          });
          return;
        }

        case 'stage.end': {
          activeStageIds.delete(event.id);
          writer.settle(event.id, {
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            data: {
              status: event.status ?? RUN_OUTCOME.COMPLETED,
              endTime: Date.now(),
            },
          });
          return;
        }

        case 'tool.start': {
          if (transcriptBoundaryClosed) return;
          settlePendingModelResponse();
          // event.logId is the canonical id — SDK consumers correlate
          // tool.start/end by it and the store entry shares the same id so
          // callers can lookup with store.get(streamId).find(e => e.id === logId).
          const data = {
            toolName: event.toolName,
            input: redactToolInputForLog(event.toolName, event.input),
            status: TOOL_USE_STATUS.IN_PROGRESS,
          } satisfies ToolUseLog;
          writer.append({
            id: event.logId,
            type: STREAM_LOG_ENTRY_TYPES.LOG,
            level: 'info',
            timestamp: Date.now(),
            groupId: event.stageId,
            messageType: MESSAGE_TYPES.TOOL_USE,
            data,
            verbose: isDebugModeEnabled(),
          });
          activeToolEntries.set(event.logId, data);
          return;
        }

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
          const patch = {
            messageType: MESSAGE_TYPES.TOOL_USE,
            data: {
              ...boundToolOutput(
                event.logId,
                redactedResult,
                event.status !== TOOL_USE_STATUS.IN_PROGRESS,
              ),
              status: event.status,
            } as ToolUseLog,
          } satisfies StreamLogUpdatePatch;
          if (event.status === TOOL_USE_STATUS.IN_PROGRESS) {
            if (writer.update(event.logId, patch)) {
              activeToolEntries.set(event.logId, patch.data);
            }
          } else {
            writer.settle(event.logId, patch);
            activeToolEntries.delete(event.logId);
          }
          return;
        }

        case 'workflow.attempt': {
          const marker = {
            kind: 'workflowAttempt',
            attemptId: event.attemptId,
          } satisfies WorkflowAttemptMarker;
          writer.appendSettled({
            id: `workflow-attempt-${event.attemptId}`,
            type: STREAM_LOG_ENTRY_TYPES.LOG,
            level: 'info',
            timestamp: Date.now(),
            groupId: event.stageId,
            messageType: MESSAGE_TYPES.INTERNAL,
            data: marker,
            verbose: false,
          });
          return;
        }

        case 'workflow.call': {
          const level: LogLevel =
            event.call.status === 'failed' ? 'error' : 'info';
          // A failed call carries a provider error body in `error`, which
          // hosts render next to the label, so it needs the same treatment as
          // an error row's `data.message`.
          const task: WorkflowCallProgress =
            event.call.status === 'failed'
              ? {
                  ...event.call,
                  label: redactSecrets(event.call.label),
                  error: redactSecrets(event.call.error),
                }
              : { ...event.call, label: redactSecrets(event.call.label) };
          const entry = {
            level,
            groupId: event.stageId,
            messageType: MESSAGE_TYPES.WORKFLOW_TASK,
            text: task.label,
            data: task,
          };
          const terminal = isTerminalWorkflowCallProgress(task);
          if (workflowCallEntries.has(event.logId)) {
            if (terminal) writer.settle(event.logId, entry);
            else writer.update(event.logId, entry);
          } else {
            workflowCallEntries.add(event.logId);
            const taskEntry = {
              id: event.logId,
              type: STREAM_LOG_ENTRY_TYPES.LOG,
              timestamp: Date.now(),
              ...entry,
              verbose: isDebugModeEnabled(),
            } satisfies StreamLogAppendInput;
            if (terminal) writer.appendSettled(taskEntry);
            else writer.append(taskEntry);
          }
          return;
        }

        case 'skills.snapshot': {
          // Schema owns redaction + sanitize + truncate for descriptions.
          const snapshot = ActiveSkillsSnapshotSchema.parse({
            skills: event.skills,
          });
          writer.appendSettled({
            id: generateShortId(),
            type: STREAM_LOG_ENTRY_TYPES.LOG,
            level: 'info',
            timestamp: Date.now(),
            groupId: event.stageId,
            messageType: MESSAGE_TYPES.ACTIVE_SKILLS,
            data: snapshot,
            verbose: false,
          });
          return;
        }

        case 'usage':
          if (event.recordTranscript === false) return;
          appendLog({
            groupId: event.stageId,
            messageType: MESSAGE_TYPES.STATISTICS,
            text: `Usage - input: ${event.payload.usage.inputTokens}, output: ${event.payload.usage.outputTokens}`,
            data: event.payload.usage,
          });
          return;

        case 'context.state': {
          const utilizationPercent = roundedUtilizationPercent(
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
          if (transcriptBoundaryClosed) return;
          const state: StreamSinkState = {
            buffer: '',
            pending: [],
            created: false,
            ended: false,
            enabled: true,
            groupId: event.stageId,
            level: 'info',
            messageType: asMessageType(event.kind),
            updateDebounce: createFlushableDebounce(() => {
              try {
                flushStream(state, event.id);
              } catch (error) {
                recordFailure(error);
              }
            }, STREAM_UPDATE_THROTTLE_MS),
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
            scheduleStreamUpdate(state);
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
          if (detachedModelResponseIds.delete(event.id)) {
            writer.settle(event.id, {});
          }
          return;
        }

        case 'response.finalized': {
          if (transcriptBoundaryClosed) return;
          if (!event.text) return;
          // Upsert by id, not by text: if this round's own MODEL_RESPONSE
          // stream already wrote a (possibly raw, pre-replacement) entry,
          // reconcile it to the authoritative text; otherwise this round never
          // streamed (e.g. a non-streaming provider call), so append it fresh.
          const correlatorId = pendingModelResponseId;
          pendingModelResponseId = undefined;
          if (correlatorId) {
            writer.settle(
              correlatorId,
              boundModelResponse(correlatorId, event.text),
            );
            return;
          }
          const id = generateShortId();
          writer.appendSettled({
            id,
            type: STREAM_LOG_ENTRY_TYPES.LOG,
            level: 'info',
            timestamp: Date.now(),
            groupId: event.stageId,
            messageType: MESSAGE_TYPES.MODEL_RESPONSE,
            ...boundModelResponse(id, event.text),
            verbose: isDebugModeEnabled(),
          });
          return;
        }

        case 'domain': {
          if (event.key === 'modelRetryLifecycle') {
            appendLog({
              groupId: event.stageId,
              messageType: MESSAGE_TYPES.INTERNAL,
              text: 'Model retry lifecycle',
              data: event.data,
              verbose: false,
            });
            return;
          }
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
            messageType:
              DOMAIN_MESSAGE_TYPE[event.key] ?? MESSAGE_TYPES.DEFAULT,
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
          // The terminal outcome is consumed by hosts via `session.onResult`,
          // and the transcript already reflects completion through `stage.end`.
          return;

        case 'run.start':
        case 'run.config':
          // Run identity/config facts drive host state through the session plane.
          // They are not transcript rows.
          return;

        case 'child.activity':
          // Child facts drive host UI badges through the session plane, not
          // transcript rows.
          return;

        default: {
          // Exhaustiveness check: adding a new event arm forces an error here.
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  };

  const handleStatus = (event: StatusEvent): void => {
    // The hub swallows subscriber throws, so a failed recorder disables
    // itself via recordFailure and surfaces the error at flushPending time
    // (run teardown) instead of throwing into the status emit loop.
    if (pendingFailure !== undefined) return;
    try {
      if (event.streamId !== streamId) return;
      if (event.phase === STREAM_PHASE.RUNNING) {
        transcriptBoundaryClosed = false;
        return;
      }
      if (
        event.phase !== STREAM_PHASE.WAITING &&
        !isTerminalOutcomePhase(event.phase)
      ) {
        return;
      }
      // Settle recorder-owned source rows at the boundary, so every row the
      // CLI may promote already has one durable settlement coordinate.
      // Workflow calls are deliberately absent: their typed bridge cleanup
      // owns planned/running terminal transitions and settles them afterward.
      transcriptBoundaryClosed = true;
      if (isTerminalOutcomePhase(event.phase)) {
        for (const id of activeStageIds) {
          writer.settle(id, {
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            data: {
              status: event.phase,
              endTime: Date.now(),
            },
          });
        }
        activeStageIds.clear();
      }
      for (const [id, state] of streams) {
        state.ended = true;
        flushStream(state, id);
        if (state.messageType === MESSAGE_TYPES.MODEL_RESPONSE) {
          writer.settle(id, {});
          detachedModelResponseIds.delete(id);
          if (pendingModelResponseId === id) pendingModelResponseId = undefined;
        }
        streams.delete(id);
      }
      if (pendingModelResponseId) {
        // A provider/abort path may close the stream without emitting the
        // authoritative response.finalized event. Settle the fully flushed,
        // redacted stream text at the lifecycle boundary.
        settlePendingModelResponse();
      }
      for (const [id, data] of activeToolEntries) {
        writer.settle(id, {
          data: {
            ...data,
            status: TOOL_USE_STATUS.FAILED,
            error: 'The stream ended before this tool completed.',
            isError: true,
          } satisfies ToolUseLog,
        });
      }
      activeToolEntries.clear();
    } catch (error) {
      recordFailure(error);
    }
  };

  const unsubscribe = trace.subscribe(subscriber);
  return {
    unsubscribe: () => {
      try {
        flushPending();
      } finally {
        unsubscribe();
      }
    },
    flushPending,
    flushSpills: async () => {
      while (pendingSpills.size > 0) {
        await Promise.all([...pendingSpills]);
      }
      const failure = pendingSpillFailure;
      pendingSpillFailure = undefined;
      if (failure !== undefined) throw failure;
    },
    handleStatus,
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
