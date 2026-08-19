import type {
  UpdateCompileFailuresMessageSchema,
  UpdateConversationProgressMessageSchema,
  UpdateFilesMessageSchema,
  UpdateMissingOutputsMessageSchema,
  UpdateStreamStatusMessageSchema,
} from './progressView/outbound';
import type { z } from 'zod';

import type { AgentCategory } from './agent';
import type { ExecutionId, StorageKey, StreamTabId } from './identifiers';
import type { FileLocation } from './output';
import type { RoundStage } from './streamState';
import type { ExtendedTokenUsageStats } from './usage';

/**
 * Fact-native payload vocabulary for session- and run-scoped runtime facts.
 *
 * These named types are the single source for the payloads carried by
 * `SessionFact` arms, typed run-fact trace events, and retained
 * runtime-host progress projections. New facts get a named payload here —
 * never a new key on a host compatibility map.
 */

export interface SetActiveStreamPayload {
  streamId: StreamTabId | null;
  agentCategory?: AgentCategory;
  /** Hint whether this is a remote agent (for UI display before the run config arrives) */
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

type UpdateStreamStatusMessage = z.infer<
  typeof UpdateStreamStatusMessageSchema
>;

export interface UpdateStreamStatusPayload {
  streamId: StreamTabId;
  status: UpdateStreamStatusMessage['status'];
  /** Diagnostic transition cause retained for legacy host/public output. */
  cause?: string;
  /** Previous phase before this update, for detecting transitions. */
  previousStatus?: UpdateStreamStatusMessage['status'];
  /** Narrower in-flight display state for launch/resume overlays. */
  substate?: UpdateStreamStatusMessage['substate'];
}

export interface AddOutputFilesPayload {
  streamId: StreamTabId;
  filesByRound: NonNullable<z.infer<typeof UpdateFilesMessageSchema>['rounds']>;
}

export interface UpdateMissingOutputsPayload {
  streamId: StreamTabId;
  filesByRound: NonNullable<
    z.infer<typeof UpdateMissingOutputsMessageSchema>['rounds']
  >;
}

export interface UpdateCompileFailuresPayload {
  streamId: StreamTabId;
  filesByRound: NonNullable<
    z.infer<typeof UpdateCompileFailuresMessageSchema>['rounds']
  >;
}

/**
 * Clear the "missing outputs" marker on exactly one tab. The initiator
 * selects the `StreamTabId` it acted on; agent/model/config identity is
 * query/display data, not command authorization, so configuration-based
 * fan-out addressing does not exist (#9590 rule A3).
 */
export interface ClearMissingOutputsPayload {
  streamId: StreamTabId;
}

/** Usage is storage-key scoped: tool-use can resume → multiple runs per tab. */
export interface UpdateStreamUsagePayload {
  streamId: StreamTabId;
  storageKey: StorageKey;
  usage: ExtendedTokenUsageStats;
}

export interface UpdateConversationProgressPayload {
  streamId: StreamTabId;
  progress: z.infer<typeof UpdateConversationProgressMessageSchema>['progress'];
}

/** Round advance within a run, projected from `stage.start` (kind 'round').
 *  Kept for the frozen public NDJSON vocabulary (`updateRoundStage`); internal
 *  state and the webview wire carry the discriminated `StreamStage` slot. */
export interface UpdateRoundStagePayload {
  streamId: StreamTabId;
  roundStage: RoundStage;
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
