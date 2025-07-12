// Local imports
import type { FileType } from '@utils/config';
import type { AgentConfig } from '@agent/core/AgentConfig';

/** Interface for storing task execution state */
export interface TaskState {
  // Agent configuration (contains all AgentConfig fields)
  agentConfig: AgentConfig;

  // UI-specific state
  /** Map of file type to active state */
  activeFiles: Record<FileType, boolean>;
}
