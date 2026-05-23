/**
 * AgentEvent — discriminated union of everything that happens during a run.
 *
 * This is the SDK contract. Adding a new event type yields an exhaustive-switch
 * error in every subscriber until handled.
 *
 * Domain-specific events that don't belong in the SDK union (TeXRA's
 * latexdiff, scratchpad, etc.) use the `domain` escape hatch.
 */
import type {
  EndGroupStatus,
  FileListEntry,
  LogLevel,
  MessageType,
  StreamLogEntry,
} from '@shared/schemas';

/** Status assigned to a tool call when it completes. */
export type ToolStatus = 'completed' | 'failed' | 'in_progress';

/**
 * StreamKind identifies what a streaming message represents. Mirrors the
 * MessageType values that AgentLogger.createStream() accepts.
 */
export type StreamKind = MessageType;

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
  readonly utilizationPercent: number;
}

/**
 * Stage stamp attached to every event by the emit boundary. Subscribers
 * read this to nest events under the active stage in the transcript;
 * SDK consumers ignore it.
 */
export interface StageStamp {
  readonly stageId?: string;
}

/** Plain log line — sugar for debug/info/warn/error converges here. */
export interface LogEvent extends StageStamp {
  readonly type: 'log';
  readonly level: LogLevel;
  readonly message: string;
  readonly data?: unknown;
  /** Optional override for the transcript's `messageType` column. */
  readonly messageType?: MessageType;
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
}

/** Stage closed with a terminal status. */
export interface StageEndEvent extends StageStamp {
  readonly type: 'stage.end';
  readonly id: string;
  readonly status: EndGroupStatus;
}

/** Tool call started. `logId` is the subscriber-correlatable id. */
export interface ToolStartEvent extends StageStamp {
  readonly type: 'tool.start';
  readonly logId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** Tool call finished. Mirrors ToolUseLog status. */
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
}

/** Context window utilisation snapshot. */
export interface ContextStateEvent extends StageStamp {
  readonly type: 'context.state';
  readonly inputTokens: number;
  readonly contextWindow: number;
}

/** Files loaded into the prompt for a given category. */
export interface FilesLoadedEvent extends StageStamp {
  readonly type: 'files.loaded';
  readonly category: string;
  readonly entries: readonly FileListEntry[];
}

/** Streaming message opened — subsequent stream.chunk events append text. */
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
 * TeXRA-specific escape hatch. Use for events that aren't part of the SDK
 * union (latexdiff, scratchpad, missingOutputs, etc.). Keeps the union clean
 * for SDK consumers; TeXRA subscribers switch on `key`.
 */
export interface DomainEvent extends StageStamp {
  readonly type: 'domain';
  readonly key: string;
  readonly data?: unknown;
  /** Optional human-readable label rendered in the transcript. */
  readonly text?: string;
}

/** Discriminated union of every event the SDK surface emits. */
export type AgentEvent =
  | LogEvent
  | StageStartEvent
  | StageEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | UsageEvent
  | ContextStateEvent
  | FilesLoadedEvent
  | StreamStartEvent
  | StreamChunkEvent
  | StreamEndEvent
  | DomainEvent;

/** Re-export the underlying stream-log entry shape so subscribers can refer to it. */
export type { StreamLogEntry };
