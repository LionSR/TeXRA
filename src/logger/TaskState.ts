// Local imports
import type { FileType } from '@utils/config';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentType } from '@agent/core/AgentDataclass';

/**
 * Interface for storing task execution state.
 *
 * This interface represents the complete state of a task, including both
 * the agent configuration and UI-specific state. The separation between
 * agentConfig and UI state (activeFiles) provides a clean architecture
 * where agent-specific settings are clearly distinguished from UI concerns.
 */
export interface TaskState {
  /**
   * Agent configuration containing all settings needed for task execution.
   * This includes model, agent type, file selections, and tool configurations.
   */
  agentConfig: AgentConfig;

  /**
   * Type of agent (e.g., CoT, direct, toolUse). Optional for backward
   * compatibility with older saved states.
   */
  agentType?: AgentType;

  /**
   * UI-specific state for managing file type visibility in the interface.
   * Maps each file type (input, reference, auxiliary, media, output) to
   * whether it should be shown in the UI.
   */
  activeFiles: Record<FileType, boolean>;
}
