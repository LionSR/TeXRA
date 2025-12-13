/**
 * Shared logging interfaces used by the logger and progress view.
 */

import type { TaskGroupStatus } from '@shared/status';

// Local imports
import type { TaskGroupId, LogMessageId } from './types/EntityTypes';
import type { LogLevel, MessageType } from './messageTypes';

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
  status: TaskGroupStatus;
  /** Parent group ID for nested groups */
  parentGroupId?: TaskGroupId;
}

export interface LogMessageData {
  /** Unique identifier for this log entry */
  id: LogMessageId;
  /** Raw message text */
  text: string;
  /** Severity level */
  level: LogLevel;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Optional group association */
  groupId?: TaskGroupId;
  /** Optional message category */
  messageType?: MessageType;
  /** Whether verbose details should be displayed */
  verbose?: boolean;
  /** Optional structured data associated with the entry */
  data?: unknown;
}

export interface LogMessageUpdate extends Partial<
  Omit<LogMessageData, 'id' | 'level' | 'timestamp'>
> {
  /** Identifier of the log entry being updated */
  id: LogMessageId;
  /** Optional severity updates for completeness */
  level?: LogMessageData['level'];
  /** Optional timestamp override */
  timestamp?: number;
}
