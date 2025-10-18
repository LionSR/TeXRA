/**
 * Shared logging interfaces used by the logger and progress view.
 */

// Local imports
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { TaskGroupId, LogMessageId } from './types/EntityTypes';

export interface TaskGroupInstructionMetadata {
  showToggle?: boolean;
  expanded?: boolean;
}

export interface TaskGroupInstruction {
  text: string;
  metadata?: TaskGroupInstructionMetadata;
}

export interface TaskGroup {
  /** Unique identifier for the group */
  id: TaskGroupId;
  /** Display name of the group */
  name: string;
  /** Unix timestamp (ms) when the group started */
  startTime: number;
  /** Unix timestamp (ms) when the group ended */
  endTime?: number;
  /** Current status of the group */
  status: 'running' | 'error' | 'stopped' | 'ready';
  /** Parent group ID for nested groups */
  parentGroupId?: TaskGroupId;
  /** Optional usage stats attached to the group */
  usage?: TokenUsageStats;
  /** Optional instruction metadata for this task group */
  instruction?: TaskGroupInstruction;
}

export interface LogMessageData {
  /** Unique identifier for this log entry */
  id: LogMessageId;
  /** Raw message text */
  text: string;
  /** Severity level */
  level: 'error' | 'warn' | 'info' | 'debug';
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Optional group association */
  groupId?: TaskGroupId;
  /** Optional message category */
  messageType?:
    | 'default'
    | 'scratchpad'
    | 'thinking'
    | 'fileList'
    | 'missingOutputs'
    | 'latexdiff'
    | 'statistics'
    | 'modelResponse'
    | 'toolUse'
    | 'userMessage'
    | 'progressStatus'
    | 'internal';
  /** Whether verbose details should be displayed */
  verbose?: boolean;
  /** Optional structured data associated with the entry */
  data?: unknown;
}

export interface LogMessageUpdate
  extends Partial<Omit<LogMessageData, 'id' | 'level' | 'timestamp'>> {
  /** Identifier of the log entry being updated */
  id: LogMessageId;
  /** Optional severity updates for completeness */
  level?: LogMessageData['level'];
  /** Optional timestamp override */
  timestamp?: number;
}
