// Third-party imports
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import Transport from 'winston-transport';

// Internal imports
import { getEmitFilter } from '@logger/filterUtils';
import type { LogMessageData } from '@logger/LogTypes';
import { MESSAGE_TYPES, type MessageType } from '@logger/messageTypes';
import type { EndGroupStatus } from '@logger/messageTypes';
import { getColorForLevel, serializeLogData } from '@logger/utils';
import { bus } from '@eventBus/ProgressEventBus';

interface VSCodeTransportOptions extends Transport.TransportStreamOptions {
  channel: vscode.OutputChannel;
  streamName: string;
  isAgentChannel: boolean;
  includeStructuredData?: () => boolean;
}

export class VSCodeTransport extends Transport {
  private readonly channel: vscode.OutputChannel;
  private readonly streamName: string;
  private readonly isAgentChannel: boolean;
  private readonly includeStructuredData?: () => boolean;

  constructor(options: VSCodeTransportOptions) {
    super(options);
    this.channel = options.channel;
    this.streamName = options.streamName;
    this.isAgentChannel = options.isAgentChannel;
    this.includeStructuredData = options.includeStructuredData;
  }

  private isValidMessageType(type: unknown): type is MessageType {
    return Object.values(MESSAGE_TYPES).includes(type as MessageType);
  }

  log(info: any, callback: () => void): void {
    const { level, message, timestamp, messageType, groupId } = info;
    const data = serializeLogData(info.data);

    this.writeToChannel(level, message, timestamp, data);
    this.emitLogEvent({
      level,
      message,
      timestamp,
      groupId,
      messageType,
      data,
    });

    callback();
  }

  startGroup(groupName: string, id: string, parentGroupId?: string): string {
    if (this.isAgentChannel) {
      bus.emit('addTaskGroup', {
        stream: this.streamName,
        id,
        name: groupName,
        startTime: Date.now(),
        status: 'running',
        endTime: undefined,
        parentGroupId,
      });
    }
    return id;
  }

  endGroup(groupId: string, status: EndGroupStatus): void {
    if (!this.isAgentChannel) return;
    bus.emit('updateTaskGroup', {
      stream: this.streamName,
      id: groupId,
      status,
      endTime: Date.now(),
    });
  }

  private writeToChannel(
    level: string,
    message: string,
    timestamp: string,
    structuredData: unknown,
  ): void {
    const emoji = getColorForLevel(level);
    const channelPrefix = this.isAgentChannel ? '' : `[${this.streamName}] `;
    const formattedMessage = `${emoji} [${timestamp}] ${channelPrefix}${message}`;
    this.channel.appendLine(formattedMessage);

    if (
      structuredData !== undefined &&
      structuredData !== null &&
      this.includeStructuredData?.()
    ) {
      const dataString =
        typeof structuredData === 'string'
          ? structuredData
          : JSON.stringify(structuredData, null, 2);
      this.channel.appendLine(dataString);
    }
  }

  /**
   * Emit log message to progress view event bus.
   * Only emits for agent channels; filters debug and internal messages
   * using shared filtering logic from filterUtils.
   */
  private emitLogEvent(event: {
    level: string;
    message: string;
    timestamp: string;
    groupId: string | undefined;
    messageType: unknown;
    data: unknown;
  }): void {
    if (!this.isAgentChannel) return;

    const validatedMessageType: MessageType = this.isValidMessageType(
      event.messageType,
    )
      ? event.messageType
      : MESSAGE_TYPES.DEFAULT;

    const level = event.level as 'debug' | 'info' | 'warn' | 'error';
    const { shouldEmit, debugMode } = getEmitFilter({
      level,
      messageType: validatedMessageType,
    });
    if (!shouldEmit) return;

    const logMessage: LogMessageData = {
      id: randomUUID(),
      text: event.message,
      level,
      timestamp: new Date(event.timestamp).getTime(),
      groupId: event.groupId,
      messageType: validatedMessageType,
      verbose: debugMode,
      data: event.data,
    };

    bus.emit('addLogMessage', {
      stream: this.streamName,
      logMessage,
    });
  }

}
