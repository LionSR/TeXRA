// Third-party imports
import { randomUUID } from 'crypto';

// Local imports - logger
import type { LogMessageData } from '@logger/LogTypes';
// Internal imports
import { MESSAGE_TYPES, type MessageType } from '@logger/messageTypes';
import { shouldEmitToProgressView } from '@logger/filterUtils';

// Type imports
import type {
  LogEventSink,
  LogGroupFinishedEvent,
  LogGroupStartedEvent,
  LogMessageEvent,
} from '@logger/types';

// Internal imports
import { getConfig } from '@utils/config';
import { bus } from '@eventBus/ProgressEventBus';

function isValidMessageType(type: unknown): type is MessageType {
  return Object.values(MESSAGE_TYPES).includes(type as MessageType);
}

export class ProgressViewSink implements LogEventSink {
  handleLogMessage(event: LogMessageEvent): void {
    const debugMode = getConfig<boolean>('texra.logger.debugMode', false);
    const messageType: MessageType = isValidMessageType(event.messageType)
      ? event.messageType
      : MESSAGE_TYPES.DEFAULT;

    // Apply shared filtering logic (debug mode + INTERNAL message filtering)
    if (!shouldEmitToProgressView({ level: event.level, messageType })) {
      return;
    }
    const id = randomUUID();
    const timestamp = new Date(event.timestamp).getTime();
    const logMessage: LogMessageData = {
      id,
      text: event.message,
      level: event.level as LogMessageData['level'],
      timestamp,
      groupId: event.groupId,
      messageType,
      verbose: debugMode,
      data: event.data,
    };

    bus.emit('addLogMessage', {
      stream: event.stream,
      logMessage,
    });
  }

  handleGroupStarted(event: LogGroupStartedEvent): void {
    bus.emit('addTaskGroup', {
      stream: event.stream,
      groupId: event.groupId,
      groupName: event.groupName,
      startTime: event.startTime,
      status: 'running',
      endTime: undefined,
      parentGroupId: event.parentGroupId,
    });
  }

  handleGroupFinished(event: LogGroupFinishedEvent): void {
    bus.emit('updateTaskGroup', {
      stream: event.stream,
      groupId: event.groupId,
      status: event.status,
      endTime: event.endTime,
    });
  }
}
