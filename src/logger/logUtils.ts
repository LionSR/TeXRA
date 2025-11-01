// Third-party imports
import * as vscode from 'vscode';
import * as winston from 'winston';
import Transport from 'winston-transport';
import { encode as encodeHtml } from 'he';
import { randomUUID } from 'crypto';

// Local imports - progressView
import { bus } from '@eventBus/ProgressEventBus';
import { getConfig } from '@utils/config';
import { TaskGroup, LogMessageData } from './LogTypes';
import { MESSAGE_TYPES, type MessageType } from './messageTypes';
import { AgentLogger } from './AgentLogger';
import { getContextGroupId } from './logContext';

function isValidMessageType(type: unknown): type is MessageType {
  return Object.values(MESSAGE_TYPES).includes(type as MessageType);
}

const { combine, timestamp } = winston.format;

// Define log levels
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Centralised emoji mapping for log levels
export const EMOJI_BY_LEVEL: Record<string, string> = {
  error: '🔴', // Red dot
  warn: '🟡', // Yellow dot
  info: '🟢', // Green dot
  debug: '🔍', // Magnifying glass
};

/**
 * Returns the emoji icon associated with a log level.
 * Falls back to a bullet if the level is not recognised.
 */
export function getColorForLevel(level: string): string {
  return EMOJI_BY_LEVEL[level.toLowerCase()] ?? '•';
}

function serializeLogData(data: unknown): unknown {
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  return data;
}

// Group State

// Main TeXRA output channel for non-agent logs
let mainOutputChannel: vscode.OutputChannel | null = null;

// Function to get or create the main output channel
function getMainOutputChannel(): vscode.OutputChannel {
  if (!mainOutputChannel) {
    mainOutputChannel = vscode.window.createOutputChannel('TeXRA');
  }
  return mainOutputChannel;
}

// Create VSCode output channel transport
class VSCodeTransport extends Transport {
  private channel: vscode.OutputChannel;
  private streamName: string;
  private isAgentChannel: boolean;
  private groups: Map<string, TaskGroup> = new Map();
  private activeGroupId?: string;

  constructor(
    channel: vscode.OutputChannel,
    streamName: string,
    isAgentChannel: boolean,
    opts?: Transport.TransportStreamOptions,
  ) {
    super(opts);
    this.channel = channel;
    this.streamName = streamName;
    this.isAgentChannel = isAgentChannel;
  }

  log(info: any, callback: () => void) {
    const { level, message, timestamp, messageType } = info;
    const structuredData = serializeLogData(info.data);
    const groupId = info.groupId || this.activeGroupId;

    this.writeToChannel(level, message, timestamp, structuredData);

    if (!this.shouldEmitToProgressView(level, messageType)) {
      callback();
      return;
    }

    this.emitToProgressView(
      level,
      message,
      timestamp,
      groupId,
      messageType,
      structuredData,
    );

    callback();
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
      getConfig<boolean>('logger.debugMode', false)
    ) {
      const dataString =
        typeof structuredData === 'string'
          ? structuredData
          : JSON.stringify(structuredData, null, 2);
      this.channel.appendLine(dataString);
    }
  }

  private shouldEmitToProgressView(
    level: string,
    messageType?: MessageType,
  ): boolean {
    if (level === 'debug' && !getConfig<boolean>('logger.debugMode', false)) {
      return false;
    }
    if (messageType === MESSAGE_TYPES.INTERNAL) {
      return false;
    }
    if (!this.isAgentChannel) {
      return false;
    }
    return true;
  }

  private emitToProgressView(
    level: string,
    message: string,
    timestamp: string,
    groupId: string | undefined,
    messageType: MessageType | undefined,
    structuredData: unknown,
  ): void {
    const processedMessage = encodeHtml(message);
    const msgType: MessageType = isValidMessageType(messageType)
      ? messageType
      : MESSAGE_TYPES.DEFAULT;
    const isVerbose = getConfig<boolean>('logger.debugMode', false);
    const id = randomUUID();
    const numericTimestamp = new Date(timestamp).getTime();
    const logMessage = {
      id,
      text: processedMessage,
      level: level as 'error' | 'warn' | 'info' | 'debug',
      timestamp: numericTimestamp,
      groupId,
      messageType: msgType,
      verbose: isVerbose,
      data: structuredData,
    } satisfies import('./LogTypes').LogMessageData;
    bus.emit('addLogMessage', {
      stream: this.streamName,
      logMessage,
    });
  }

  // Create a new log group and make it active
  startGroup(
    groupName: string,
    id: string = randomUUID(),
    parentGroupId?: string,
  ): string {
    const groupId = id;
    const now = Date.now();

    this.groups.set(groupId, {
      id: groupId,
      name: groupName,
      startTime: now,
      status: 'running',
      parentGroupId,
    });

    this.activeGroupId = groupId;

    // Skip progress view updates for non-agent channels
    if (!this.isAgentChannel) {
      return groupId;
    }

    bus.emit('addTaskGroup', {
      stream: this.streamName,
      groupId,
      groupName,
      startTime: now,
      status: 'running',
      endTime: undefined,
      parentGroupId,
    });

    return groupId;
  }

  // End the current group
  endGroup(groupId: string, status: 'error' | 'stopped' = 'stopped'): void {
    const group = this.groups.get(groupId);
    if (!group) {
      return;
    }

    const now = Date.now();
    group.endTime = now;
    group.status = status;

    // Skip progress view updates for non-agent channels
    if (!this.isAgentChannel) {
      return;
    }

    bus.emit('updateTaskGroup', {
      stream: this.streamName,
      groupId,
      status,
      endTime: group.endTime,
    });

    if (this.activeGroupId === groupId) {
      // If this group has a parent, set that as the active group
      const parentGroupId = group.parentGroupId;
      this.activeGroupId = parentGroupId;
    }
  }

  // Get the active group ID
  getActiveGroupId(): string | undefined {
    return this.activeGroupId;
  }

  // Set the active group ID explicitly (useful for switching context)
  setActiveGroupId(groupId: string | undefined): void {
    if (groupId === undefined || this.groups.has(groupId)) {
      this.activeGroupId = groupId;
    }
  }

  // Get a group by ID
  getGroup(groupId: string): TaskGroup | undefined {
    return this.groups.get(groupId);
  }
}

// Map to store loggers for different categories
const channelLoggers = new Map<string, winston.Logger>();
const channelTransports = new Map<string, VSCodeTransport>();

export function initialize(defaultChannel: string, isAgent = false): void {
  // Create default logger if it doesn't exist
  if (!channelLoggers.has(defaultChannel)) {
    createLoggerForChannel(defaultChannel, isAgent);
  }
}

function createLoggerForChannel(
  channel: string,
  isAgent = false,
): winston.Logger {
  // Check if channel already exists
  if (channelLoggers.has(channel)) {
    return channelLoggers.get(channel)!;
  }

  const outputChannel: vscode.OutputChannel = isAgent
    ? vscode.window.createOutputChannel('TeXRA ' + channel)
    : getMainOutputChannel();

  // Create transport
  const transport = new VSCodeTransport(outputChannel, channel, isAgent);
  channelTransports.set(channel, transport);

  const logger = winston.createLogger({
    levels: logLevels,
    level: 'debug',
    format: combine(
      timestamp({
        format: 'YYYY-MM-DD HH:mm:ss.SSS', // Add milliseconds for better precision
      }),
    ),
    transports: [transport],
  });

  channelLoggers.set(channel, logger);
  return logger;
}

// Start a log group for the given channel
export function startGroup(
  channel: string,
  groupName: string,
  id: string = randomUUID(),
  parentGroupId?: string,
  isAgent = false,
): string {
  const transport = channelTransports.get(channel);
  if (!transport) {
    createLoggerForChannel(channel, isAgent);
    const newTransport = channelTransports.get(channel)!;
    return newTransport.startGroup(groupName, id, parentGroupId);
  }

  return transport.startGroup(groupName, id, parentGroupId);
}

// End a log group
export function endGroup(
  channel: string,
  groupId: string,
  status: 'error' | 'stopped' = 'stopped',
): void {
  const transport = channelTransports.get(channel);
  if (transport) {
    transport.endGroup(groupId, status);
  }
}

// Get the active group ID for a channel
export function getActiveGroupId(channel: string): string | undefined {
  const transport = channelTransports.get(channel);
  return transport?.getActiveGroupId();
}

// Set the active group ID for a channel
export function setActiveGroupId(
  channel: string,
  groupId: string | undefined,
): void {
  const transport = channelTransports.get(channel);
  if (transport) {
    transport.setActiveGroupId(groupId);
  }
}

// Log with group association
function logWithGroup(
  channel: string,
  level: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void {
  const logger = getOrCreateLogger(channel, isAgent);
  const transport = channelTransports.get(channel);
  const contextGroupId = getContextGroupId(channel);

  // If no groupId provided, prefer the async context before falling back to the transport state
  const actualGroupId =
    groupId ?? contextGroupId ?? transport?.getActiveGroupId();

  // @ts-ignore - We're adding a custom property to the winston log
  logger[level](message, { groupId: actualGroupId, messageType, data });
}

// Simplified logging methods that use channel as channel name
export const debug = (
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void => {
  logWithGroup(channel, 'debug', message, groupId, messageType, isAgent, data);
};

export const info = (
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void => {
  logWithGroup(channel, 'info', message, groupId, messageType, isAgent, data);
};

export const warn = (
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void => {
  logWithGroup(channel, 'warn', message, groupId, messageType, isAgent, data);
};

export const error = (
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void => {
  logWithGroup(channel, 'error', message, groupId, messageType, isAgent, data);
};

function getOrCreateLogger(channel: string, isAgent = false): winston.Logger {
  if (!channelLoggers.has(channel)) {
    return createLoggerForChannel(channel, isAgent);
  }
  return channelLoggers.get(channel)!;
}

export function getTimestamp(): string {
  return new Date()
    .toLocaleString('en-US', {
      year: '2-digit',
      // we do not want to show the year
      month: '2-digit',
      day: '2-digit',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    .replace(',', '');
}
