// Third-party imports
import { createContext } from '@lit/context';

// Local imports - progress view
import type {
  FollowupOptionsState,
  StreamState,
  ToolUseStreamState,
  WorkflowStreamState,
} from '../store';

// Local imports - progress view components
import type { PromptState } from '../components/PromptOverlay';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

export interface StreamContextValue {
  streamInfo: StreamTabInfo | null;
  streamState: StreamState | null;
  runId: string | null;
  followupOptions: FollowupOptionsState | null;
  /** Pre-computed stream type flag - true for tool-use, false for workflow */
  isToolUse: boolean;
}

/**
 * Get the typed tool-use state from context.
 * Only call this when you know the stream is tool-use type (isToolUse === true).
 */
export function getToolUseState(
  context: StreamContextValue,
): ToolUseStreamState | null {
  if (context.isToolUse && context.streamState) {
    return context.streamState as ToolUseStreamState;
  }
  return null;
}

/**
 * Get the typed workflow state from context.
 * Only call this when you know the stream is workflow type (isToolUse === false).
 */
export function getWorkflowState(
  context: StreamContextValue,
): WorkflowStreamState | null {
  if (!context.isToolUse && context.streamState) {
    return context.streamState as WorkflowStreamState;
  }
  return null;
}

export const streamStateContext = createContext<StreamContextValue>(
  'progress-stream-state',
);

export const promptsContext = createContext<PromptState[]>('progress-prompts');
