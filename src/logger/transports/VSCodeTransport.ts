// Third-party imports
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import Transport from 'winston-transport';

// Internal imports
import {
  ContextManagementDataSchema,
  ContextStateDataSchema,
  type ContextStateData,
} from '@logger/AgentLogger';
import { getEmitFilter } from '@logger/filterUtils';
import type { LogMessageData } from '@logger/LogTypes';
import {
  MESSAGE_TYPES,
  MessageTypeSchema,
  type MessageType,
} from '@logger/messageTypes';
import type { EndGroupStatus } from '@logger/messageTypes';
import { getColorForLevel } from '@logger/utils';
import { serializeError } from '@utils/core';
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

  log(info: any, callback: () => void): void {
    const { level, message, timestamp, messageType, groupId } = info;
    // Serialize errors for logging (inline from serializeLogData)
    const data = info.data instanceof Error ? serializeError(info.data) : info.data;

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

    // Use Zod schema with .catch() for O(1) validation with automatic fallback
    const messageType = MessageTypeSchema.catch(MESSAGE_TYPES.DEFAULT).parse(
      event.messageType,
    );

    const level = event.level as 'debug' | 'info' | 'warn' | 'error';
    const { shouldEmit, debugMode } = getEmitFilter({ level, messageType });
    if (!shouldEmit) return;

    bus.emit('addLogMessage', {
      stream: this.streamName,
      logMessage: {
        id: randomUUID(),
        text: event.message,
        level,
        timestamp: new Date(event.timestamp).getTime(),
        groupId: event.groupId,
        messageType,
        verbose: debugMode,
        data: event.data,
      },
    });

    this.maybeEmitContextState(messageType, event.data);
  }

  /**
   * Parse and emit context state for CONTEXT_MANAGEMENT and CONTEXT_STATE messages.
   * Each message type uses a different schema and derivation logic.
   */
  private maybeEmitContextState(messageType: MessageType, data: unknown): void {
    if (!data) return;

    switch (messageType) {
      case MESSAGE_TYPES.CONTEXT_MANAGEMENT: {
        const parseResult = ContextManagementDataSchema.safeParse(data);
        if (!parseResult.success) return;

        const contextData = parseResult.data;
        const inputTokens =
          contextData.tokensAfter ?? contextData.tokensBefore ?? 0;
        const utilizationPercent =
          contextData.utilizationAfter ??
          (inputTokens / contextData.contextWindow) * 100;

        this.emitContextState({
          inputTokens,
          contextWindow: contextData.contextWindow,
          utilizationPercent,
        });
        break;
      }
      case MESSAGE_TYPES.CONTEXT_STATE: {
        const parseResult = ContextStateDataSchema.safeParse(data);
        if (!parseResult.success) return;

        this.emitContextState(parseResult.data);
        break;
      }
    }
  }

  /**
   * Emit context state to the progress view event bus.
   * Shared helper for both CONTEXT_MANAGEMENT and CONTEXT_STATE messages.
   */
  private emitContextState(contextState: ContextStateData): void {
    bus.emit('updateContextState', {
      stream: this.streamName,
      contextState,
    });
  }
}
