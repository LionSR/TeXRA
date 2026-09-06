/**
 * Deterministic projection of trace facts to transcript entries. The caller
 * supplies the event clock and id; this fold owns no clock, timer, random
 * generator, subscription, filesystem handle, or durable write.
 */
// Shared contracts and utilities
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
  type WorkflowPlanMarker,
  type WorkflowCallProgress,
  type TranscriptEvent,
  type StreamPhase,
} from '@shared/schemas';
import { roundedUtilizationPercent } from '@shared/streams/contextUtilization';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import type {
  StreamLog,
  StreamLogAppendInput,
  StreamLogUpdatePatch,
} from '@shared/session/traceEntries';
import { isObject } from '@utils/core';
import { redactToolInputForLog, redactLogData } from './traceRedaction';

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

/** The source event's stable coordinates and the surface's display policy. */
export interface TraceStamp {
  readonly at: number;
  readonly id: string;
  readonly debug: boolean;
}

type StageMetadata = Pick<
  Extract<TranscriptEvent, { type: 'stage.start' }>,
  'kind' | 'index' | 'total'
> & { readonly attemptId?: string };

/** Build the transcript projection for one subscribed aggregate. */
export function createTranscriptFold(
  writer: Pick<
    StreamLog,
    'append' | 'appendSettled' | 'update' | 'settle' | 'appendText'
  >,
) {
  const streams = new Map<
    string,
    { groupId: string | undefined; messageType: MessageType; chunks: string[] }
  >();
  const activeToolEntries = new Map<string, ToolUseLog>();
  const stageMetadata = new Map<string, StageMetadata>();
  const workflowCallEntries = new Set<string>();
  let workflowAttemptId: string | undefined;
  let pendingModelResponseId: string | undefined;
  let transcriptBoundaryClosed = false;
  const record = (event: TranscriptEvent, stamp: TraceStamp): void => {
    const appendLog = (params: {
      level?: LogLevel;
      groupId: string | undefined;
      messageType: MessageType;
      text: string;
      data?: unknown;
      verbose?: boolean;
    }): void => {
      writer.appendSettled({
        id: stamp.id,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: params.level ?? 'info',
        timestamp: stamp.at,
        groupId: params.groupId,
        messageType: params.messageType,
        text: redactSecrets(params.text),
        data: redactLogData(params.data),
        verbose: params.verbose ?? stamp.debug,
      });
    };

    switch (event.type) {
      case 'log': {
        const messageType = asMessageType(event.messageType);
        if (
          messageType === MESSAGE_TYPES.INTERNAL ||
          (event.level === 'debug' && !stamp.debug)
        )
          return;
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
          ...(event.kind === 'phase' && workflowAttemptId !== undefined
            ? { attemptId: workflowAttemptId }
            : {}),
          ...(event.index !== undefined ? { index: event.index } : {}),
          ...(event.total !== undefined ? { total: event.total } : {}),
        } satisfies StageMetadata;
        stageMetadata.set(event.id, metadata);
        // A new model-turn boundary starts fresh: whatever MODEL_RESPONSE
        // stream the previous turn may have opened is no longer this turn's
        // to reuse. Tool-use turns are session stages containing several
        // inner model/tool rounds, while other flows expose round stages.
        if (event.kind === 'round' || event.kind === 'session') {
          pendingModelResponseId = undefined;
        }
        writer.appendSettled({
          id: event.id,
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          level: 'info',
          timestamp: stamp.at,
          groupId: event.parentId ?? undefined,
          messageType: MESSAGE_TYPES.DEFAULT,
          text: redactSecrets(event.label),
          data: {
            status: STREAM_PHASE.RUNNING,
            ...metadata,
          },
          verbose: stamp.debug,
        });
        return;
      }

      case 'stage.end': {
        const metadata = stageMetadata.get(event.id);
        stageMetadata.delete(event.id);
        writer.update(event.id, {
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          data: {
            status: event.status ?? RUN_OUTCOME.COMPLETED,
            endTime: stamp.at,
            ...metadata,
          },
        });
        return;
      }

      case 'tool.start': {
        if (transcriptBoundaryClosed) return;
        pendingModelResponseId = undefined;
        // event.logId is the canonical id. SDK consumers correlate
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
          timestamp: stamp.at,
          groupId: event.stageId,
          messageType: MESSAGE_TYPES.TOOL_USE,
          data,
          verbose: stamp.debug,
        });
        activeToolEntries.set(event.logId, data);
        return;
      }

      case 'tool.end': {
        if (transcriptBoundaryClosed) return;
        const result = (event.result ?? {}) as Partial<ToolUseLog>;
        const redactedResult =
          typeof result.toolName === 'string'
            ? {
                ...result,
                input: redactToolInputForLog(result.toolName, result.input),
              }
            : result;
        // Omit groupId on update: undefined would clobber the canonical
        // value stamped at tool.start (deferred tools never copy the
        // resolved id back into their ref).
        const patch = {
          messageType: MESSAGE_TYPES.TOOL_USE,
          data: {
            ...redactedResult,
            status: event.status,
          } as ToolUseLog,
        } satisfies StreamLogUpdatePatch;
        if (event.status === TOOL_USE_STATUS.IN_PROGRESS) {
          writer.update(event.logId, patch);
          activeToolEntries.set(event.logId, patch.data);
        } else {
          writer.settle(event.logId, patch);
          activeToolEntries.delete(event.logId);
        }
        return;
      }

      case 'workflow.plan': {
        workflowAttemptId = event.attemptId;
        // Display strings pass through record-time redaction like every
        // stage label and card the recorder persists; ids stay verbatim.
        const marker = {
          kind: 'workflowPlan',
          attemptId: event.attemptId,
          phases: event.phases.map((phase) => ({
            title: redactSecrets(phase.title),
          })),
          tasks: event.tasks.map((task) => ({
            ...task,
            label: redactSecrets(task.label),
            ...(task.phase !== undefined && {
              phase: redactSecrets(task.phase),
            }),
          })),
        } satisfies WorkflowPlanMarker;
        writer.appendSettled({
          id: `workflow-plan-${event.attemptId}`,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: 'info',
          timestamp: stamp.at,
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
            timestamp: stamp.at,
            ...entry,
            verbose: stamp.debug,
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
          id: stamp.id,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: 'info',
          timestamp: stamp.at,
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
          text: `Usage - input: ${event.usage.inputTokens}, output: ${event.usage.outputTokens}`,
          data: event.usage,
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
        const state = {
          groupId: event.stageId,
          messageType: asMessageType(event.kind),
          chunks: [] as string[],
        };
        streams.set(event.id, state);
        if (state.messageType === MESSAGE_TYPES.MODEL_RESPONSE)
          pendingModelResponseId = event.id;
        writer.append({
          id: event.id,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: 'info',
          timestamp: stamp.at,
          groupId: state.groupId,
          messageType: state.messageType,
          text: '',
          data: { status: 'running' },
          verbose: stamp.debug,
        });
        return;
      }
      case 'stream.chunk': {
        if (transcriptBoundaryClosed) return;
        const state = streams.get(event.id);
        if (!state) return;
        state.chunks.push(event.text);
        writer.appendText(event.id, redactSecrets(event.text));
        return;
      }
      case 'stream.end': {
        const state = streams.get(event.id);
        if (!state || transcriptBoundaryClosed) return;
        const text = event.finalText ?? state.chunks.join('');
        writer.settle(event.id, {
          text: redactSecrets(text),
          data: { status: 'completed' },
        });
        streams.delete(event.id);
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
          writer.settle(correlatorId, {
            text: redactSecrets(event.text),
            data: { status: 'completed' },
          });
          return;
        }
        const id = stamp.id;
        writer.appendSettled({
          id,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: 'info',
          timestamp: stamp.at,
          groupId: event.stageId,
          messageType: MESSAGE_TYPES.MODEL_RESPONSE,
          text: redactSecrets(event.text),
          data: { status: 'completed' },
          verbose: stamp.debug,
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
          messageType: DOMAIN_MESSAGE_TYPE[event.key] ?? MESSAGE_TYPES.DEFAULT,
          text: event.text ?? event.key,
          data: event.data,
        });
        return;
      }
    }
  };
  const status = (phase: StreamPhase): void => {
    if (phase === STREAM_PHASE.RUNNING) {
      transcriptBoundaryClosed = false;
      return;
    }
    if (phase !== STREAM_PHASE.WAITING && !isTerminalOutcomePhase(phase))
      return;
    transcriptBoundaryClosed = true;
    pendingModelResponseId = undefined;
    for (const [id, state] of streams) {
      writer.settle(id, {
        text: redactSecrets(state.chunks.join('')),
        data: { status: 'completed' },
      });
    }
    streams.clear();
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
  };
  return { record, status };
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
