// Third-party imports
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import Transport from 'winston-transport';

// Internal imports
import { bus } from '@eventBus/ProgressEventBus';
import { getEmitFilter } from '@logger/filterUtils';
import type { LogMessageData, TaskGroup } from '@logger/LogTypes';
import { MESSAGE_TYPES, type MessageType } from '@logger/messageTypes';
import type { EndGroupStatus } from '@logger/messageTypes';
import { getColorForLevel, serializeLogData } from '@logger/utils';

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
  private readonly groups = new Map<string, TaskGroup>();
  private activeGroupId?: string;

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
    const { level, message, timestamp, messageType } = info;
    const data = serializeLogData(info.data);
    const groupId = info.groupId ?? this.activeGroupId;

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
    const now = Date.now();
    const group: TaskGroup = {
      id,
      name: groupName,
      startTime: now,
      status: 'running',
      parentGroupId,
    };
    this.groups.set(id, group);
    this.activeGroupId = id;

    this.emitGroupStarted(id, groupName, now, parentGroupId);

    return id;
  }

  endGroup(groupId: string, status: EndGroupStatus): void {
    const group = this.groups.get(groupId);
    if (!group) {
      return;
    }

    group.endTime = Date.now();
    group.status = status;

    this.emitGroupFinished(groupId, status, group.endTime);

    if (this.activeGroupId === groupId) {
      this.activeGroupId = group.parentGroupId;
    }
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

  /**
   * Emit task group started to progress view event bus.
   */
  private emitGroupStarted(
    id: string,
    name: string,
    startTime: number,
    parentGroupId?: string,
  ): void {
    if (!this.isAgentChannel) return;

    bus.emit('addTaskGroup', {
      stream: this.streamName,
      id,
      name,
      startTime,
      status: 'running',
      endTime: undefined,
      parentGroupId,
    });
  }

  /**
   * Emit task group finished to progress view event bus.
   */
  private emitGroupFinished(
    id: string,
    status: EndGroupStatus,
    endTime: number,
  ): void {
    if (!this.isAgentChannel) return;

    bus.emit('updateTaskGroup', {
      stream: this.streamName,
      id,
      status,
      endTime,
    });
  }
}
