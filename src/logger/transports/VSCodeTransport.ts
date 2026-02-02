import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import Transport from 'winston-transport';

import {
  ContextStateDataSchema,
  MESSAGE_TYPES,
  MessageTypeSchema,
  type EndGroupStatus,
  type LogLevel,
  type MessageType,
} from '@shared/schemas';
import { getEmitFilter } from '@logger/filterUtils';
import { getColorForLevel } from '@logger/utils';
import { serializeError } from '@utils/core';
import { bus } from '@eventBus/ProgressEventBus';

interface VSCodeTransportOptions extends Transport.TransportStreamOptions {
  channel: vscode.OutputChannel;
  streamId: string;
  isAgentChannel: boolean;
  includeStructuredData?: () => boolean;
}

export class VSCodeTransport extends Transport {
  private readonly channel: vscode.OutputChannel;
  private readonly streamId: string;
  private readonly isAgentChannel: boolean;
  private readonly includeStructuredData?: () => boolean;

  constructor(options: VSCodeTransportOptions) {
    super(options);
    this.channel = options.channel;
    this.streamId = options.streamId;
    this.isAgentChannel = options.isAgentChannel;
    this.includeStructuredData = options.includeStructuredData;
  }

  log(info: any, callback: () => void): void {
    const { level, message, timestamp, messageType, groupId } = info;
    const data =
      info.data instanceof Error ? serializeError(info.data) : info.data;

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
        streamId: this.streamId,
        id,
        name: groupName,
        startTime: Date.now(),
        status: 'running',
        parentGroupId,
      });
    }
    return id;
  }

  endGroup(groupId: string, status: EndGroupStatus): void {
    if (!this.isAgentChannel) return;
    bus.emit('updateTaskGroup', {
      streamId: this.streamId,
      id: groupId,
      status,
      endTime: Date.now(),
    });
  }

  private writeToChannel(
    level: LogLevel,
    message: string,
    timestamp: string,
    structuredData: unknown,
  ): void {
    const emoji = getColorForLevel(level);
    const prefix = this.isAgentChannel ? '' : `[${this.streamId}] `;
    this.channel.appendLine(`${emoji} [${timestamp}] ${prefix}${message}`);

    if (structuredData != null && this.includeStructuredData?.()) {
      const dataString =
        typeof structuredData === 'string'
          ? structuredData
          : JSON.stringify(structuredData, null, 2);
      this.channel.appendLine(dataString);
    }
  }

  private emitLogEvent(event: {
    level: LogLevel;
    message: string;
    timestamp: string;
    groupId: string | undefined;
    messageType: unknown;
    data: unknown;
  }): void {
    if (!this.isAgentChannel) return;

    const messageType = MessageTypeSchema.catch(MESSAGE_TYPES.DEFAULT).parse(
      event.messageType,
    );

    const { shouldEmit, debugMode } = getEmitFilter({
      level: event.level,
      messageType,
    });
    if (!shouldEmit) return;

    bus.emit('addLogMessage', {
      streamId: this.streamId,
      logMessage: {
        id: randomUUID(),
        text: event.message,
        level: event.level,
        timestamp: new Date(event.timestamp).getTime(),
        groupId: event.groupId,
        messageType,
        verbose: debugMode,
        data: event.data,
      },
    });

    this.maybeEmitContextState(messageType, event.data);
  }

  private maybeEmitContextState(messageType: MessageType, data: unknown): void {
    if (messageType !== MESSAGE_TYPES.CONTEXT_STATE || !data) return;

    const parseResult = ContextStateDataSchema.safeParse(data);
    if (!parseResult.success) return;

    bus.emit('updateContextState', {
      streamId: this.streamId,
      contextState: parseResult.data,
    });
  }
}
