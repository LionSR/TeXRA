import type { z } from 'zod';

import type { AgentCategory } from './agent';
import type { ExecutionId, StreamTabId } from './identifiers';
import type { FileLocation } from './output';
import type { RoundKeyedOutputSidecarValueSchemas } from './streamState';
import type { ExtendedTokenUsageStats } from './usage';

/**
 * Shared output-file, usage, goal-pause, and host-presentation payloads.
 * Session state is defined by SessionEvent; payload shapes retained only for
 * public CLI NDJSON output belong to the CLI's compatibility table.
 */

export interface AddOutputFilesPayload {
  streamId: StreamTabId;
  filesByRound: z.infer<typeof RoundKeyedOutputSidecarValueSchemas.outputFiles>;
}

export interface UpdateMissingOutputsPayload {
  streamId: StreamTabId;
  filesByRound: z.infer<
    typeof RoundKeyedOutputSidecarValueSchemas.missingOutputs
  >;
}

export interface UpdateCompileFailuresPayload {
  streamId: StreamTabId;
  filesByRound: z.infer<
    typeof RoundKeyedOutputSidecarValueSchemas.compileFailures
  >;
}

/** Usage is execution-scoped; a resume accumulates onto the same key. The
 *  field name is frozen by the public NDJSON vocabulary. */
export interface UpdateStreamUsagePayload {
  streamId: StreamTabId;
  storageKey: ExecutionId;
  usage: ExtendedTokenUsageStats;
}

/**
 * An autonomous goal auto-paused after a failed cycle ended the autonomous
 * leg. Hosts surface this so a paused goal is distinguishable from a hang.
 */
export interface GoalPausedPayload {
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

/** Request the frontend to show the agent-config banner in the main webview.
 *  The category is the one the missing agent was launched as: the banner's
 *  action edits that catalog, not whatever surface happens to be open. */
export interface ShowAgentConfigBannerPayload {
  agentName: string;
  category: AgentCategory;
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
