// Third-party imports
// (none)

// Local imports - logger
import type { MessageType } from '../messageTypes';

export interface LogMessageEvent {
  level: string;
  message: string;
  timestamp: string;
  stream: string;
  groupId?: string;
  messageType?: MessageType;
  data?: unknown;
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
  status: 'error' | 'stopped';
  endTime: number;
}

export interface LogEventSink {
  handleLogMessage(event: LogMessageEvent): void;
  handleGroupStarted(event: LogGroupStartedEvent): void;
  handleGroupFinished(event: LogGroupFinishedEvent): void;
}
