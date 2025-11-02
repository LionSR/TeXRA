// Third-party imports
import * as vscode from 'vscode';
import Transport from 'winston-transport';

// Local imports - logger
import { getColorForLevel } from '../utils/levelColors';
import type {
  LogEventSink,
  LogGroupFinishedEvent,
  LogGroupStartedEvent,
  LogMessageEvent,
} from '../types/LogEventSink';
import { serializeLogData } from '../utils/serializeLogData';

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
  status: 'running' | 'error' | 'stopped';
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
    const now = Date.now();
    const group: TransportGroup = {
      id,
      name: groupName,
      startTime: now,
      status: 'running',
      parentGroupId,
    };
    this.groups.set(id, group);
    this.activeGroupId = id;

    this.emitGroupStarted({
      stream: this.streamName,
      groupId: id,
      groupName,
      startTime: now,
      parentGroupId,
    });

    return id;
  }

  endGroup(groupId: string, status: 'error' | 'stopped'): void {
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

    if (this.activeGroupId === groupId) {
      this.activeGroupId = group.parentGroupId;
    }
  }

  getActiveGroupId(): string | undefined {
    return this.activeGroupId;
  }

  setActiveGroupId(groupId: string | undefined): void {
    if (groupId === undefined || this.groups.has(groupId)) {
      this.activeGroupId = groupId;
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

