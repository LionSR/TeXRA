import type { AgentCategory } from './agent';
import type { ExecutionId, StorageKey, StreamTabId } from './identifiers';
import type { CompileFailure, FileLocation, OutputFileInfo } from './output';
import type { RoundIndexed } from './roundIndexed';
import type {
  ActiveChildInfo,
  ConversationProgress,
  RoundStage,
} from './streamState';
import type { StreamPhase, StreamSubstate } from './stream';
import type { ExtendedTokenUsageStats } from './usage';

/**
 * Fact-native payload vocabulary for session- and run-scoped runtime facts.
 *
 * These named types are the single source for the payloads carried by
 * `SessionFact` arms, typed run-fact trace events, and retained
 * runtime-host progress projections. New facts get a named payload here —
 * never a new key on a host compatibility map.
 */

/** Payload base for stream-scoped run facts (one run per workflow tab). */
interface StreamScopedPayload {
  streamId: StreamTabId;
  executionId?: ExecutionId;
}

export interface SetActiveStreamPayload {
  streamId: StreamTabId | null;
  agentCategory?: AgentCategory;
  /** Hint whether this is a remote agent (for UI display before TaskState is set) */
  isRemote?: boolean;
  /**
   * When true, register the stream (state, logs, hints) but do NOT switch the
   * active tab to it. Used by background child streams (bash, codex) so the
   * stream tab appears without yanking the user away from their current view.
   */
  suppressViewSwitch?: boolean;
  /**
   * When suppressing a switch, widen a restrictive category filter so this
   * stream remains reachable. Used for interaction requests with pending UI.
   */
  ensureVisible?: boolean;
}

export interface UpdateStreamDescriptionPayload {
  streamId: StreamTabId;
  description: string;
}

export interface SetParentStreamPayload {
  childStreamId: StreamTabId;
  parentStreamId: StreamTabId | null;
}

export interface RemoveStreamPayload {
  streamId: StreamTabId;
}

export interface UpdateStreamStatusPayload {
  streamId: StreamTabId;
  status: StreamPhase;
  /** Diagnostic transition cause retained for legacy host/public output. */
  cause?: string;
  /** Previous phase before this update, for detecting transitions. */
  previousStatus?: StreamPhase;
  /** Narrower in-flight display state for launch/resume overlays. */
  substate?: StreamSubstate;
}

export interface AddOutputFilesPayload extends StreamScopedPayload {
  filesByRound: RoundIndexed<OutputFileInfo>;
}

export interface UpdateMissingOutputsPayload extends StreamScopedPayload {
  filesByRound: RoundIndexed<string>;
}

export interface UpdateCompileFailuresPayload extends StreamScopedPayload {
  filesByRound: RoundIndexed<CompileFailure>;
}

/**
 * Clear the "missing outputs" marker. Either target a specific tab via
 * `streamId`, or clear every workflow tab whose taskState matches the
 * given `streamConfig` (for command-palette pack/clean which has no
 * stream context).
 */
export type ClearMissingOutputsPayload =
  | { streamId: StreamTabId; streamConfig?: undefined }
  | {
      streamId?: undefined;
      streamConfig: {
        agent: string;
        model: string;
        inputFile: string;
        outputFiles?: readonly string[];
      };
    };

/** Usage is storage-key scoped: tool-use can resume → multiple runs per tab. */
export interface UpdateStreamUsagePayload {
  streamId: StreamTabId;
  storageKey: StorageKey;
  executionId?: ExecutionId;
  usage: ExtendedTokenUsageStats;
}

export interface UpdateConversationProgressPayload {
  streamId: StreamTabId;
  progress: ConversationProgress;
}

/** Round advance within a run, projected from `stage.start` (kind 'round'). */
export interface UpdateRoundStagePayload {
  streamId: StreamTabId;
  roundStage: RoundStage;
}

/** Active subagent roster, projected from `child.activity` (kind 'subagents'). */
export interface UpdateActiveSubagentsPayload {
  parentStreamId: StreamTabId;
  children: ActiveChildInfo[];
}

/** Active process roster, projected from `child.activity` (kind 'processes'). */
export interface UpdateActiveProcessesPayload {
  parentStreamId: StreamTabId;
  processes: ActiveChildInfo[];
}

/** Incremental child-process output, projected from `process.output`. */
export interface UpdateProcessOutputPayload {
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
  stdout: string;
  stderr: string;
}

/**
 * An autonomous goal auto-paused after a failed cycle ended the autonomous
 * leg. Hosts surface this so a paused goal is distinguishable from a hang.
 */
export interface GoalPausedPayload {
  streamId: StreamTabId;
}

/**
 * A Goal record mutated (start/pause/resume/complete/abandon/edit-objective/
 * cap-reached) so UI surfaces (header chip, settings tab, progress board)
 * can refresh. The agent owns state transitions through the plan tool.
 */
export interface GoalStateChangedPayload {
  streamId: StreamTabId;
}

export interface UpdateQueuedFollowUpsPayload {
  streamId: StreamTabId;
}

export interface FollowUpSentPayload {
  streamId: StreamTabId;
}

/**
 * Host-agnostic action tokens for {@link RequestShowInstructionPayload}.
 * The agent core emits a token; each host maps it to its own UI affordance
 * (the VS Code extension to a command + button title, other hosts as they see
 * fit). This keeps host-specific command IDs and labels out of the VS Code-free
 * agent core.
 */
export const INSTRUCTION_ACTION = {
  SET_API_KEY: 'set-api-key',
  OPEN_CONFIGURATION_GUIDE: 'open-configuration-guide',
  OPEN_MODELS_DOC: 'open-models-doc',
} as const;

export type InstructionAction =
  (typeof INSTRUCTION_ACTION)[keyof typeof INSTRUCTION_ACTION];

/** Request the frontend to open a file (and build+display if LaTeX). */
export interface RequestOpenFilePayload {
  location: FileLocation;
  preserveFocus: boolean;
}

/** Request the frontend to show a suppressible instruction message. */
export interface RequestShowInstructionPayload {
  key: string;
  message: string;
  /**
   * Host-agnostic action tokens rendered as buttons. The host maps each
   * token to its own UI affordance (see {@link INSTRUCTION_ACTION}).
   */
  actions?: InstructionAction[];
  showSuppress?: boolean;
}

/** Request the frontend to show the agent-config banner in the main webview. */
export interface ShowAgentConfigBannerPayload {
  agentName: string;
}

/** Request the frontend to show an error message via a host notification. */
export interface RequestShowErrorPayload {
  message: string;
}

/**
 * Request the frontend to ensure the progress view is visible.
 * If the view cannot be opened and a fallback notification is provided,
 * show a toast notification as a last resort.
 */
export interface RequestEnsureProgressViewPayload {
  fallbackNotification?: {
    agentName: string;
    modelName: string;
    inputName: string;
    outputInfo: string;
  };
}
