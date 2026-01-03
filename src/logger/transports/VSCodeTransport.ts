// Third-party imports
import * as vscode from 'vscode';
import Transport from 'winston-transport';

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

export class VSCodeTransport extends Transport {
  private readonly channel: vscode.OutputChannel;
  private readonly streamName: string;
  private readonly sink?: LogEventSink;
  private readonly isAgentChannel: boolean;
  private readonly includeStructuredData?: () => boolean;
  private activeGroupId?: string;

  constructor(options: VSCodeTransportOptions) {
    super(options);
    this.channel = options.channel;
    this.streamName = options.streamName;
    this.sink = options.sink;
    this.isAgentChannel = options.isAgentChannel;
    this.includeStructuredData = options.includeStructuredData;
  }

  log(info: any, callback: () => void): void {
    const { level, message, timestamp, messageType } = info;
    const structuredData = serializeLogData(info.data);
    const groupId = info.groupId ?? this.activeGroupId;

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
    this.activeGroupId = id;
    this.emitGroupStarted({
      stream: this.streamName,
      groupId: id,
      groupName,
      startTime: Date.now(),
      parentGroupId,
    });
    return id;
  }

  endGroup(groupId: string, status: EndGroupStatus, parentGroupId?: string): void {
    this.emitGroupFinished({
      stream: this.streamName,
      groupId,
      status,
      endTime: Date.now(),
    });
    if (this.activeGroupId === groupId) {
      this.activeGroupId = parentGroupId;
    }
  }

  getActiveGroupId(): string | undefined {
    return this.activeGroupId;
  }

  setActiveGroupId(groupId: string | undefined): void {
    this.activeGroupId = groupId;
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
