/**
 * Shared logging interfaces used by the logger and progress view.
 */

// Local imports
import type { TokenUsageStats } from '../types/UsageTypes';

export interface TaskGroup {
  /** Unique identifier for the group */
  id: string;
  /** Display name of the group */
  name: string;
  /** Unix timestamp (ms) when the group started */
  startTime: number;
  /** Unix timestamp (ms) when the group ended */
  endTime?: number;
  /** Current status of the group */
  status: 'running' | 'error' | 'stopped' | 'ready';
  /** Parent group ID for nested groups */
  parentGroupId?: string;
  /** Optional usage stats attached to the group */
  usage?: TokenUsageStats;
}

export interface LogMessageData {
  /** Unique identifier for this log entry */
  id: string;
  /** Raw message text */
  text: string;
  /** Severity level */
  level: 'error' | 'warn' | 'info' | 'debug';
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Optional group association */
  groupId?: string;
  /** Optional message category */
  messageType?:
    | 'default'
    | 'scratchpad'
    | 'thinking'
    | 'fileList'
    | 'outputReminder';
  /** Whether verbose details should be displayed */
  verbose?: boolean;
}
