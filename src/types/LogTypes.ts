/**
 * Shared logging interfaces used by the logger and progress view.
 */

import type { TokenUsageStats } from './UsageTypes';

export interface LogGroup {
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

export interface ColoredLogMessage {
  /** HTML-formatted log message */
  message: string;
  /** Severity level of the message */
  level: 'error' | 'warn' | 'info' | 'debug';
  /** Unix timestamp (ms) for ordering */
  timestamp: number;
  /** Optional group association */
  groupId?: string;
  /** Message subtype for styling */
  messageType?: 'default' | 'scratchpad' | 'thinking';
}

export interface LogEvent {
  stream: string;
  logMessage: ColoredLogMessage;
}

export interface LogGroupEvent {
  stream: string;
  group: LogGroup;
}

export interface UpdateLogGroupEvent {
  stream: string;
  groupId: string;
  status: LogGroup['status'];
  endTime?: number;
}
