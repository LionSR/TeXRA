/**
 * AgentEvent — discriminated union of everything that happens during a run.
 *
 * This is the agent-general SDK contract. Adding a new event type yields
 * an exhaustive-switch error in every subscriber until handled.
 *
 * Host-specific events that don't belong in the core union (TeXRA's
 * file-list payloads, latexdiff, scratchpad, etc.) use the `domain`
 * escape hatch with a host-chosen `key`.
 */
import type { RunUsageTotals } from '@agent/core/usage/RunUsageAccumulator';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentErrorKind } from '@common/errors';
import type { StreamTransitionCause } from '@common/constants/streamStatus';
import type {
  ActiveChildInfo,
  AddOutputFilesPayload,
  ConversationProgress,
  GoalPausedPayload,
  ExecutionId,
  RetryErrorInfo,
  RunOutcome,
  StreamPhase,
  StreamSubstate,
  StreamTabId,
  UpdateCompileFailuresPayload,
  UpdateMissingOutputsPayload,
  UpdatePlanPayload,
  UpdateTodosPayload,
} from '@shared/schemas';
import type { RunDescriptor } from '@shared/schemas/runDescriptor';

/** Status assigned to a tool call when it completes. */
export type ToolStatus = 'completed' | 'failed' | 'in_progress';

/**
 * StreamKind identifies what a streaming message represents. Subscribers
 * key on it for render decisions. Generic string so host taxonomies
 * (TeXRA's MessageType) plug in without coupling the SDK.
 */
export type StreamKind = string;

/** Token-usage stats emitted at the end of each model turn. */
export interface TokenUsageStats {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly cacheReadTokens?: number;
  readonly [key: string]: number | undefined;
}

/** Context-state snapshot emitted around context-management checkpoints. */
export interface ContextStateData {
  readonly inputTokens: number;
  readonly contextWindow: number;
}

/**
 * Stage stamp attached to every event by the emit boundary. Subscribers
 * read this to nest events under the active stage in the transcript;
 * agent-general SDK consumers may ignore it.
 */
export interface StageStamp {
  readonly stageId?: string;
}

/** Plain log line — sugar for debug/info/warn/error converges here. */
export interface LogEvent extends StageStamp {
  readonly type: 'log';
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data?: unknown;
  /** Host-specific category (e.g. TeXRA's MessageType taxonomy). */
  readonly messageType?: string;
  /**
   * If false, the renderer should treat this as a verbose/debug-only line.
   * Defaults to true for non-debug levels.
   */
  readonly verbose?: boolean;
}

/** Stage opened (parent of subsequent events until matching stage.end). */
export interface StageStartEvent extends StageStamp {
  readonly type: 'stage.start';
  readonly id: string;
  readonly label: string;
  readonly parentId?: string;
  readonly kind?: 'run' | 'round' | 'phase' | 'session';
  readonly index?: number;
  readonly total?: number;
}

/** Immutable run identity emitted once when a stream enters RUNNING. */
export interface RunStartEvent extends StageStamp {
  readonly type: 'run.start';
  readonly descriptor: RunDescriptor;
}

/** Mutable persisted run config changed after run.start, e.g. model switch. */
export interface RunConfigEvent extends StageStamp {
  readonly type: 'run.config';
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly config: AgentConfig;
}

/** Stage closed with a terminal status. */
export interface StageEndEvent extends StageStamp {
  readonly type: 'stage.end';
  readonly id: string;
  readonly status: RunOutcome;
}

/** Tool call started. `logId` is the subscriber-correlatable id. */
export interface ToolStartEvent extends StageStamp {
  readonly type: 'tool.start';
  readonly logId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/**
 * Patch to an open tool call, correlated by `logId`. Usually a terminal
 * update (`status: 'completed' | 'failed'`) that closes the call, but a
 * streaming tool emits repeated `tool.end` events with
 * `status: 'in_progress'` to push incremental output to the same card
 * before it finishes. Subscribers should treat the event as an
 * upsert keyed on `logId` and rely on `status` for terminality rather than
 * assuming the call is done.
 */
export interface ToolEndEvent extends StageStamp {
  readonly type: 'tool.end';
  readonly logId: string;
  readonly status: ToolStatus;
  /** Subscriber-correlatable patch payload (output, summary, etc.). */
  readonly result?: unknown;
}

/** Token-usage report. */
export interface UsageEvent extends StageStamp {
  readonly type: 'usage';
  readonly stats: TokenUsageStats;
  /**
   * Host/product-specific usage projection payload. Agent-general consumers can
   * ignore this; TeXRA uses it to project sidebar totals from the same trace
   * event that records transcript statistics.
   */
  readonly data?: unknown;
  /** False when this usage report should not create a transcript stats row. */
  readonly recordTranscript?: boolean;
}

/** Stream lifecycle phase change emitted by the session-owned status machine. */
export interface StatusEvent extends StageStamp {
  readonly type: 'status';
  readonly streamId: StreamTabId;
  readonly phase: StreamPhase;
  readonly previousPhase?: StreamPhase;
  readonly cause: StreamTransitionCause;
  readonly substate?: StreamSubstate;
}

/** Session-owned child/process activity for a parent run stream. */
export type ChildActivityEvent =
  | (StageStamp & {
      readonly type: 'child.activity';
      readonly kind: 'subagents';
      readonly parentStreamId: StreamTabId;
      readonly children: readonly ActiveChildInfo[];
    })
  | (StageStamp & {
      readonly type: 'child.activity';
      readonly kind: 'processes';
      readonly parentStreamId: StreamTabId;
      readonly processes: readonly ActiveChildInfo[];
    });

/** Incremental output from a child process owned by a parent run stream. */
export interface ProcessOutputEvent extends StageStamp {
  readonly type: 'process.output';
  readonly parentStreamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly stdout: string;
  readonly stderr: string;
}

/** UI progress counters for a run, projected by hosts but not transcript logs. */
export interface ConversationProgressEvent extends StageStamp {
  readonly type: 'conversation.progress';
  readonly progress: ConversationProgress;
}

/** Durable TeXRA run facts carried by the run trace with fact-native names. */
export type RunFactEvent =
  | (StageStamp &
      UpdateTodosPayload & {
        readonly type: 'updateTodos';
      })
  | (StageStamp &
      UpdatePlanPayload & {
        readonly type: 'updatePlan';
      })
  | (StageStamp &
      AddOutputFilesPayload & {
        readonly type: 'addOutputFiles';
      })
  | (StageStamp &
      UpdateMissingOutputsPayload & {
        readonly type: 'updateMissingOutputs';
      })
  | (StageStamp &
      UpdateCompileFailuresPayload & {
        readonly type: 'updateCompileFailures';
      })
  | (StageStamp &
      GoalPausedPayload & {
        readonly type: 'goalPaused';
      });

/** Context window utilisation snapshot. */
export interface ContextStateEvent extends StageStamp {
  readonly type: 'context.state';
  readonly inputTokens: number;
  readonly contextWindow: number;
}

/**
 * Streaming message opened — subsequent stream.chunk events append text.
 * Marks the moment the phase the stream represents actually began (emitters
 * fire it at the provider's phase signal, or at the first content chunk via
 * `StreamOptions.deferStart`), so subscribers may surface liveness — "the
 * model is thinking / responding" — from this event alone.
 */
export interface StreamStartEvent extends StageStamp {
  readonly type: 'stream.start';
  readonly id: string;
  readonly kind: StreamKind;
}

/** Chunk appended to an open stream. */
export interface StreamChunkEvent extends StageStamp {
  readonly type: 'stream.chunk';
  readonly id: string;
  readonly text: string;
}

/** Stream closed; finalText, when provided, replaces the buffered content. */
export interface StreamEndEvent extends StageStamp {
  readonly type: 'stream.end';
  readonly id: string;
  readonly finalText?: string;
}

/**
 * Authoritative final assistant text for the round that just ended the
 * turn — decided once at the flow boundary where `assembly.lastResponse` is
 * set (after `extractResponse`'s replacement-rule cleanup runs), and carried
 * as data from there rather than re-derived downstream. Fires at every
 * mid-run turn boundary (the tool-use loop pausing to wait for the next user
 * message), not only the terminal round, so a subscriber never has to guess
 * whether the run is "really" done (#7086).
 *
 * The round's own MODEL_RESPONSE stream (when the response actually
 * streamed) writes raw provider chunks in real time, before replacement
 * rules run — so its persisted text can trivially differ from this event's
 * text (e.g. a literal vs. a replaced LaTeX symbol). Subscribers reconcile by
 * updating that stream's entry to this text instead of a caller having to
 * prove the two already match.
 */
export interface ResponseFinalizedEvent extends StageStamp {
  readonly type: 'response.finalized';
  readonly text: string;
}

/**
 * Host-specific escape hatch. Hosts use this for events that aren't part
 * of the agent-general union (TeXRA: `latexdiff`, `scratchpad`,
 * `filesLoaded`, `missingOutputs`, `webSearch`, `webFetch`, …). Keeps the
 * union clean for SDK consumers; host subscribers switch on `key`.
 */
export interface DomainEvent extends StageStamp {
  readonly type: 'domain';
  readonly key: string;
  readonly data?: unknown;
  /** Optional human-readable label rendered in the transcript. */
  readonly text?: string;
}

/**
 * Fields `formatProviderHttpError`'s `terminalError()` branch actually sets
 * for `abort` / `disk-full` (see `src/common/errors/sdkError/
 * providerErrorFormat.ts`): it deliberately opts out of provider/relay/
 * credential classification, so `statusCode`/`provider`/`requestId`/
 * `exhaustionReason` are never populated for these kinds.
 */
type ResultEventLocalError = Readonly<{
  message?: string;
  userRetryable?: RetryErrorInfo['userRetryable'];
  isRelayError?: RetryErrorInfo['isRelayError'];
  streamDiagnostics?: RetryErrorInfo['streamDiagnostics'];
  partialText?: RetryErrorInfo['partialText'];
}>;

/**
 * Fields available for `missing-api-key` / `unexpected`, which fall through
 * `formatProviderHttpError` to the general SDK/provider-error classification
 * path and so may populate the full `RetryErrorInfo` shape (minus `message`,
 * carried separately, and `rawErrorBody`, stripped as bulky by
 * `toRetryErrorInfo` at the emission boundary).
 */
type ResultEventProviderError = ResultEventLocalError &
  Readonly<
    Partial<
      Omit<
        RetryErrorInfo,
        | 'message'
        | 'userRetryable'
        | 'isRelayError'
        | 'streamDiagnostics'
        | 'partialText'
      >
    >
  >;

/**
 * Terminal run outcome as data — emitted exactly once at the run-lifecycle
 * boundary (`runFlowWithLifecycle`), never from flows or the bus. `cancelled`
 * is a sibling of `failed` (a user interrupt is not a failure). `error.kind` is
 * the classified terminal-error discriminant, and it also selects which
 * `RetryErrorInfo` fields are ever populated: `abort`/`disk-full` are always
 * local, non-provider failures (`ResultEventLocalError`), while
 * `missing-api-key`/`unexpected` go through the general provider/SDK
 * classification and may carry the fuller shape (`ResultEventProviderError`) —
 * see `formatProviderHttpError` in `src/common/errors/sdkError/
 * providerErrorFormat.ts`. `usage` is the run totals (present once at least
 * one round recorded usage, including on failures).
 */
export interface ResultEvent extends StageStamp {
  readonly type: 'result';
  readonly outcome: RunOutcome;
  readonly executionId: string;
  readonly streamId: string;
  readonly agentName: string;
  readonly category: 'toolUse' | 'workflow';
  readonly isSubagent: boolean;
  readonly error?:
    | (ResultEventLocalError & {
        readonly kind: Extract<AgentErrorKind, 'abort' | 'disk-full'>;
      })
    | (ResultEventProviderError & {
        readonly kind: Extract<
          AgentErrorKind,
          'missing-api-key' | 'unexpected'
        >;
      });
  readonly usage?: RunUsageTotals;
}

/** Discriminated union of every event the SDK surface emits. */
export type AgentEvent =
  | LogEvent
  | RunStartEvent
  | RunConfigEvent
  | StageStartEvent
  | StageEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | UsageEvent
  | StatusEvent
  | ChildActivityEvent
  | ProcessOutputEvent
  | ConversationProgressEvent
  | RunFactEvent
  | ContextStateEvent
  | StreamStartEvent
  | StreamChunkEvent
  | StreamEndEvent
  | ResponseFinalizedEvent
  | DomainEvent
  | ResultEvent;
