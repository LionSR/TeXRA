// Third-party imports
import { randomUUID } from 'crypto';
import { encode as encodeHtml } from 'he';

// Local imports - progress view
import { bus } from '@eventBus/ProgressEventBus';
import { getConfig } from '@utils/config';
import type { LogMessageData } from '../LogTypes';
import { MESSAGE_TYPES, type MessageType } from '../messageTypes';
import type {
  LogEventSink,
  LogGroupFinishedEvent,
  LogGroupStartedEvent,
  LogMessageEvent,
} from '../types/LogEventSink';

function isValidMessageType(type: unknown): type is MessageType {
  return Object.values(MESSAGE_TYPES).includes(type as MessageType);
}

export class ProgressViewSink implements LogEventSink {
  handleLogMessage(event: LogMessageEvent): void {
    if (event.messageType === MESSAGE_TYPES.INTERNAL) {
      return;
    }

    const debugMode = getConfig<boolean>('texra.logger.debugMode', false);
    if (event.level === 'debug' && !debugMode) {
      return;
    }

    const processedMessage = encodeHtml(event.message);
    const messageType: MessageType = isValidMessageType(event.messageType)
      ? event.messageType
      : MESSAGE_TYPES.DEFAULT;
    const id = randomUUID();
    const timestamp = new Date(event.timestamp).getTime();
    const logMessage: LogMessageData = {
      id,
      text: processedMessage,
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
