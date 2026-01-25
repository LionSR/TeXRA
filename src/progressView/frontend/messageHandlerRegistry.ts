/**
 * Message handler registry for ProgressView.
 *
 * Maps VS Code webview commands to their handler functions.
 * Using a registry pattern improves maintainability over a large switch statement.
 */

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import {
  handleAddTaskGroup,
  handleAppendLog,
  handleDeleteAll,
  handleDeleteStream,
  handleFollowUpTextPolished,
  handleFollowUpTextTranscribed,
  handleRecordingError,
  handleRecordingStarted,
  handleRecordingStopped,
  handleResolveBashApproval,
  handleResolveAgentProposal,
  handleResolveRetryRequest,
  handleResolveToolEditApproval,
  handleSetFollowupOptions,
  handleShowAgentProposal,
  handleShowBashApproval,
  handleShowRetryRequest,
  handleShowToolEditApproval,
  handleUpdateContextState,
  handleUpdateFiles,
  handleUpdateInstruction,
  handleUpdateLog,
  handleUpdateLogs,
  handleUpdateMissingOutputs,
  handleUpdateQueuedFollowUps,
  handleUpdateRunUsage,
  handleUpdateStatus,
  handleUpdateStreamStatus,
  handleUpdateStreams,
  handleUpdateTaskGroup,
  handleUpdateTodos,
  handleUpdateToolEditApprovalState,
  handleUpdateUsage,
  type MessageHandler,
} from './messageHandlers';

/**
 * Registry mapping VS Code commands to message handlers.
 * Each handler receives the raw message and a context object for state access.
 */
export const MESSAGE_HANDLERS: Record<string, MessageHandler> = {
  // Stream management
  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]: handleUpdateStreams,
  [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: handleDeleteStream,
  [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: handleDeleteAll,

  // Log updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_LOGS]: handleUpdateLogs,
  [PROGRESS_VIEW_COMMANDS.APPEND_LOG]: handleAppendLog,
  [PROGRESS_VIEW_COMMANDS.UPDATE_LOG]: handleUpdateLog,

  // Status updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_STATUS]: handleUpdateStatus,
  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS]: handleUpdateStreamStatus,

  // File and output updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_FILES]: handleUpdateFiles,
  [PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS]: handleUpdateMissingOutputs,

  // Run-specific updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION]: handleUpdateInstruction,
  [PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE]: handleUpdateRunUsage,
  [PROGRESS_VIEW_COMMANDS.UPDATE_USAGE]: handleUpdateUsage,
  [PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE]: handleUpdateContextState,

  // Task group updates
  [PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP]: handleAddTaskGroup,
  [PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP]: handleUpdateTaskGroup,

  // Tool-use specific
  [PROGRESS_VIEW_COMMANDS.UPDATE_TODOS]: handleUpdateTodos,
  [PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS]: handleUpdateQueuedFollowUps,

  // Approval requests
  [PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL]: handleShowToolEditApproval,
  [PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL]: handleResolveToolEditApproval,
  [PROGRESS_VIEW_COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE]: handleUpdateToolEditApprovalState,
  [PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL]: handleShowBashApproval,
  [PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL]: handleResolveBashApproval,
  [PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST]: handleShowRetryRequest,
  [PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST]: handleResolveRetryRequest,
  [PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL]: handleShowAgentProposal,
  [PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL]: handleResolveAgentProposal,

  // Follow-up and recording
  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED]: handleFollowUpTextPolished,
  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED]: handleFollowUpTextTranscribed,
  [PROGRESS_VIEW_COMMANDS.RECORDING_STARTED]: handleRecordingStarted,
  [PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED]: handleRecordingStopped,
  [PROGRESS_VIEW_COMMANDS.RECORDING_ERROR]: handleRecordingError,
  [PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS]: handleSetFollowupOptions,
};
