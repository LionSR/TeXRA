// Data model for the CLI TUI's signal-backed state. Mirrors the webview's
// `progressState` shape — same primitives (`@lit-labs/signals`), same shape
// (one record per stream + an `activeStreamId`) so future feature parity is a
// port, not a rewrite. Phase 4 extends with per-stream subagent/process/todos/
// plan/process-output fields plus the per-stream bypass-state badges the
// StatusBar consumes.

import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import type { RunModelDecisionReason } from '@model/runModelDecision';
import {
  STREAM_STATUS,
  type ActiveChildInfo,
  type AgentCategory,
  type ConversationProgress,
  type NormalizedToolUse,
  type Plan,
  type RoundStage,
  type StreamLifecycleStatus,
  type StreamSubstate,
  type StreamTabId,
  type TodoItem,
  type TokenUsageStats,
} from '@shared/schemas';

interface ConversationEntryBase {
  /** Same id as the upstream `StreamLogEntry.id` — stable across deltas. */
  readonly id: string;
  /** Concatenated text for `MODEL_RESPONSE` entries. Empty for tool rows. */
  readonly text: string;
  /** True while rendered assistant text is hiding an incomplete protocol block. */
  readonly pendingEmbeddedSubagentFollowup?: boolean;
  /** True once the stream transitions to `WAITING`/`COMPLETED`. */
  readonly finalized: boolean;
  /** Entry was synthesized by the CLI and is not present in StreamLogStore. */
  readonly synthetic?: boolean;
  /** Why the CLI synthesized this entry. */
  readonly syntheticKind?: 'final' | 'local' | 'process';
  /** StreamLog head at the moment a synthetic entry was appended. */
  readonly syntheticAfterSeq?: number;
}

/**
 * Discriminated on `role` so `toolUse`/`process` are required exactly for
 * the rows that need them, instead of independently-optional fields every
 * consumer has to null-check regardless of role.
 */
export type ConversationEntry =
  | (ConversationEntryBase & { readonly role: 'assistant' | 'error' | 'user' })
  | (ConversationEntryBase & {
      readonly role: 'tool';
      readonly toolUse: NormalizedToolUse;
    })
  | (ConversationEntryBase & {
      readonly role: 'process';
      readonly process: CompletedProcessTranscript;
    });

export interface CompletedProcessTranscript {
  readonly executionId: string;
  readonly title: string;
  readonly status?: string;
  readonly elapsed?: string | null;
  readonly isError: boolean;
  readonly tailLines: readonly string[];
}

export interface SessionMeta {
  readonly agent: string;
  readonly model: string;
  readonly modelSource: RunModelDecisionReason;
  readonly cwd: string;
  readonly apiMode: CliApiMode;
  readonly approvalPolicy: CliApprovalPolicy;
  readonly canDelegate: boolean;
  readonly teamName?: string;
  readonly version: string;
}

export interface ProcessOutputTail {
  readonly stdout: string;
  readonly stderr: string;
}

export interface BypassState {
  readonly bash: boolean;
  readonly toolEdit: boolean;
  readonly superYolo: boolean;
}

export interface StreamSlice {
  readonly streamId: StreamTabId;
  /** Model identity captured from setTaskState for this specific stream. */
  readonly model?: string | undefined;
  /** Agent category for this stream (`toolUse` / `workflow` / …), captured
   *  from `setTaskState` or `setActiveStream`. Lets the exit hint list only
   *  resumable tool-use subagents (workflows don't resume). */
  readonly category: AgentCategory | undefined;
  readonly status: StreamLifecycleStatus | undefined;
  readonly substate?: StreamSubstate;
  /** Epoch ms when this stream last entered `RUNNING`; cleared on any other
   *  status. Drives the StatusBar's live elapsed-time segment so a long
   *  token-less "thinking" turn still shows liveness. */
  readonly runStartedAt: number | undefined;
  readonly description: string | undefined;
  /** Latest model usage snapshot. The StatusBar treats this as current context
   *  occupancy, so it must not be accumulated across turns. */
  readonly usage: TokenUsageStats | undefined;
  /** Accumulated usage for resume/exit summaries across all turns in this
   *  stream. Kept separate from `usage` so the context-window indicator remains
   *  a latest-snapshot display. */
  readonly cumulativeUsage: TokenUsageStats | undefined;
  /** True while the latest hidden provider-side reasoning/thinking stream is
   *  the current live activity. The CLI never renders the content directly;
   *  this only drives a lightweight liveness indicator. */
  readonly thinkingActive: boolean;
  readonly conversation: ConversationProgress | undefined;
  readonly roundStage?: RoundStage | undefined;
  readonly entries: readonly ConversationEntry[];
  readonly queuedFollowUps: number;
  readonly queuedFollowUpMessages: readonly string[];
  readonly activeSubagents: readonly ActiveChildInfo[];
  readonly activeProcesses: readonly ActiveChildInfo[];
  /** Child streams seen for this parent. This keeps completed/waiting
   * subagent pages addressable after they leave the active list. */
  readonly childStreams: readonly ActiveChildInfo[];
  readonly todos: readonly TodoItem[];
  readonly plan: Plan | null;
  /** Tailed stdout/stderr per execution id; latest only — capped at
   *  `PROCESS_TAIL_CHARS_MAX` in subscribeRuntimeHost. */
  readonly processOutput: ReadonlyMap<string, ProcessOutputTail>;
  /** YOLO / auto-approval state is stream-scoped upstream (see
   *  `permissionSlice.ts` in the extension), so concurrent parent/child
   *  sessions can show distinct badges. */
  readonly bypass: BypassState;
}

/**
 * Shared gate for the "model is thinking" indicators (the StatusBar segment
 * and the conversation pane's liveness row) so the two can never disagree:
 * the hidden reasoning phase is only worth surfacing while the stream is
 * actually running — any final or waiting status supersedes it.
 */
export function thinkingIndicatorVisible(
  slice:
    | { readonly status: string | undefined; readonly thinkingActive: boolean }
    | undefined,
): boolean {
  return (
    slice?.thinkingActive === true && slice.status === STREAM_STATUS.RUNNING
  );
}

export const NO_BYPASS: BypassState = {
  bash: false,
  toolEdit: false,
  superYolo: false,
};

export function emptySlice(streamId: StreamTabId): StreamSlice {
  return {
    streamId,
    model: undefined,
    category: undefined,
    status: undefined,
    substate: undefined,
    runStartedAt: undefined,
    description: undefined,
    thinkingActive: false,
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    roundStage: undefined,
    entries: [],
    queuedFollowUps: 0,
    queuedFollowUpMessages: [],
    activeSubagents: [],
    activeProcesses: [],
    childStreams: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: NO_BYPASS,
  };
}
