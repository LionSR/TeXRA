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
import type { EndGroupStatus } from '@shared/schemas';

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
  readonly utilizationPercent: number;
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

/** Tool call finished. */
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

/** Discriminated union of every event the SDK surface emits. */
export type AgentEvent =
  | LogEvent
  | StageStartEvent
  | StageEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | UsageEvent
  | ContextStateEvent
  | StreamStartEvent
  | StreamChunkEvent
  | StreamEndEvent
  | DomainEvent;
