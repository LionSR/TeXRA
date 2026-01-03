// Third-party imports
import * as vscode from 'vscode';
import Transport from 'winston-transport';

import type { TaskGroupStatus } from '@common/constants/streamStatus';
// Local imports - logger
import { getColorForLevel, serializeLogData } from '@logger/utils';
import type { EndGroupStatus } from '@logger/messageTypes';
// Type imports
import type {
  LogEventSink,
  LogGroupFinishedEvent,
  LogGroupStartedEvent,
  LogMessageEvent,
} from '@logger/types';

interface VSCodeTransportOptions extends Transport.TransportStreamOptions {
  channel: vscode.OutputChannel;
  streamName: string;
  sink?: LogEventSink;
  isAgentChannel: boolean;
  includeStructuredData?: () => boolean;
}

interface TransportGroup {
  id: string;
  name: string;
  startTime: number;
  status: TaskGroupStatus;
  parentGroupId?: string;
  endTime?: number;
}

export class VSCodeTransport extends Transport {
  private readonly channel: vscode.OutputChannel;
  private readonly streamName: string;
  private readonly sink?: LogEventSink;
  private readonly isAgentChannel: boolean;
  private readonly includeStructuredData?: () => boolean;
  private readonly groups = new Map<string, TransportGroup>();

  constructor(options: VSCodeTransportOptions) {
    super(options);
    this.channel = options.channel;
    this.streamName = options.streamName;
    this.sink = options.sink;
    this.isAgentChannel = options.isAgentChannel;
    this.includeStructuredData = options.includeStructuredData;
  }

  log(info: any, callback: () => void): void {
    const { level, message, timestamp, messageType, groupId } = info;
    const structuredData = serializeLogData(info.data);

    this.writeToChannel(level, message, timestamp, structuredData);
    this.emitLogEvent({
      level,
      message,
      timestamp,
      stream: this.streamName,
      groupId,
      messageType,
      data: structuredData,
    });

    callback();
  }

  startGroup(groupName: string, id: string, parentGroupId?: string): string {
    const now = Date.now();
    const group: TransportGroup = {
      id,
      name: groupName,
      startTime: now,
      status: 'running',
      parentGroupId,
    };
    this.groups.set(id, group);

    this.emitGroupStarted({
      stream: this.streamName,
      groupId: id,
      groupName,
      startTime: now,
      parentGroupId,
    });

    return id;
  }

  endGroup(groupId: string, status: EndGroupStatus): void {
    const group = this.groups.get(groupId);
    if (!group) {
      return;
    }

    group.endTime = Date.now();
    group.status = status;

    this.emitGroupFinished({
      stream: this.streamName,
      groupId,
      status,
      endTime: group.endTime,
    });

    // Clean up completed group to prevent memory accumulation
    this.groups.delete(groupId);
  }

  /**
   * Clear internal state without disposing the output channel.
   * Used during extension deactivation for transports sharing the main channel.
   */
  clearState(): void {
    this.groups.clear();
  }

  /**
   * Close the transport: clear state and dispose of the output channel.
   * Only call this for agent channels that own their output channel.
   */
  close(): void {
    this.clearState();
    this.channel.dispose();
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

  private emitLogEvent(event: LogMessageEvent): void {
    this.sink?.handleLogMessage(event);
  }

  private emitGroupStarted(event: LogGroupStartedEvent): void {
    this.sink?.handleGroupStarted(event);
  }

  private emitGroupFinished(event: LogGroupFinishedEvent): void {
    this.sink?.handleGroupFinished(event);
  }
}
