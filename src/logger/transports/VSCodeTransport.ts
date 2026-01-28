import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import Transport from 'winston-transport';

import {
  ContextStateDataSchema,
  MESSAGE_TYPES,
  MessageTypeSchema,
  type ContextStateData,
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
    // Serialize errors for logging (inline from serializeLogData)
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
        endTime: undefined,
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
    level: string,
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

    const level = event.level as LogLevel;
    const { shouldEmit, debugMode } = getEmitFilter({ level, messageType });
    if (!shouldEmit) return;

    bus.emit('addLogMessage', {
      streamId: this.streamId,
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
   * Emit context state for CONTEXT_STATE messages only.
   *
   * CONTEXT_STATE messages contain actual API token counts from responses,
   * which are accurate. CONTEXT_MANAGEMENT messages contain pre-request
   * estimates (e.g., from gpt-tokenizer) which can differ significantly
   * from actual counts, especially for OpenAI models.
   *
   * By only emitting from CONTEXT_STATE, the UI always shows actual token
   * counts rather than potentially inaccurate estimates.
   */
  private maybeEmitContextState(messageType: MessageType, data: unknown): void {
    // Only emit context state from CONTEXT_STATE messages (actual API tokens)
    // Skip CONTEXT_MANAGEMENT to avoid overwriting actual counts with estimates
    if (messageType !== MESSAGE_TYPES.CONTEXT_STATE || !data) return;

    const parseResult = ContextStateDataSchema.safeParse(data);
    if (!parseResult.success) return;

    this.emitContextState(parseResult.data);
  }

  /**
   * Emit context state to the progress view event bus.
   */
  private emitContextState(contextState: ContextStateData): void {
    bus.emit('updateContextState', {
      streamId: this.streamId,
      contextState,
    });
  }
}
