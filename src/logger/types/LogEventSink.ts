// (none)

// Local imports - logger
import type { EndGroupStatus, MessageType } from '@logger/messageTypes';

export interface LogMessageEvent {
  level: string;
  message: string;
  timestamp: string;
  stream: string;
  groupId?: string;
  messageType?: MessageType;
  data?: unknown;
  /** Optional stable ID for deduplication. If provided, replaces existing message with same ID. */
  messageId?: string;
}

export interface LogGroupStartedEvent {
  stream: string;
  groupId: string;
  groupName: string;
  startTime: number;
  parentGroupId?: string;
}

export interface LogGroupFinishedEvent {
  stream: string;
  groupId: string;
  status: EndGroupStatus;
  endTime: number;
}

export interface LogEventSink {
  handleLogMessage(event: LogMessageEvent): void;
  handleGroupStarted(event: LogGroupStartedEvent): void;
  handleGroupFinished(event: LogGroupFinishedEvent): void;
}
