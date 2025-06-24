// Third-party imports
import * as vscode from 'vscode';
import * as winston from 'winston';
import Transport from 'winston-transport';
import { randomUUID } from 'crypto';

// Local imports - progressView
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { getConfig } from '@utils/config';
import {
  shouldUseConsolidatedChannel,
  getColorForLevel,
  isAgentStream,
  EMOJI_BY_LEVEL as emojis,
} from '@utils/loggerUtils';
import { TaskGroup } from './LogTypes';

// Message type for ProgressView entries
export type MessageType = 'thinking' | 'scratchpad' | 'default';

function isValidMessageType(type: string): type is 'thinking' | 'scratchpad' {
  return type === 'thinking' || type === 'scratchpad';
}

const { combine, timestamp } = winston.format;

// Define log levels
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Group State

// Helper function to escape HTML tags
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper function to unescape HTML tags
export function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&');
}

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
  private progressViewProvider?: ProgressViewProvider;
  private streamName: string;
  private useConsolidatedChannel: boolean;
  private messageBuffer: {
    id: string;
    level: string;
    message: string;
    timestamp: number;
    groupId?: string;
    messageType?: 'default' | 'scratchpad' | 'thinking';
  }[] = [];
  private groups: Map<string, TaskGroup> = new Map();
  private activeGroupId?: string;

  constructor(
    channel: vscode.OutputChannel,
    streamName: string,
    useConsolidatedChannel: boolean,
    progressViewProvider?: ProgressViewProvider,
    opts?: Transport.TransportStreamOptions,
  ) {
    super(opts);
    this.channel = channel;
    this.streamName = streamName;
    this.useConsolidatedChannel = useConsolidatedChannel;
    this.progressViewProvider = progressViewProvider;
  }

  log(info: any, callback: () => void) {
    const { level, message, timestamp } = info;
    // Use the provided groupId or fall back to the activeGroupId if available
    const groupId = info.groupId || this.activeGroupId;

    const emoji = getColorForLevel(level);

    // Extract parts of the timestamp for display formatting
    // Full format is: YYYY-MM-DD HH:mm:ss.SSS
    const timeDisplay = timestamp.split(' ')[1].split('.')[0]; // Drop milliseconds for UI display

    // For consolidated channel, include the source channel in the message
    const channelPrefix = this.useConsolidatedChannel
      ? `[${this.streamName}] `
      : '';

    // Plain format for output channel - no escaping needed but include better formatting
    // const formattedMessage = `${emoji} [${timestamp}] ${level.toUpperCase().padEnd(7)} ${channelPrefix}${message}`;
    const formattedMessage = `${emoji} [${timestamp}] ${channelPrefix}${message}`;

    // Key behavior change: For agent streams, we ONLY write to their dedicated channel
    // For non-agent streams, we write to the consolidated channel
    // This prevents duplicate output in both places
    if (this.useConsolidatedChannel || !isAgentStream(this.streamName)) {
      this.channel.appendLine(formattedMessage);
    }

    // Skip debug messages in ProgressView if debug mode is disabled
    if (level === 'debug' && !getConfig<boolean>('logger.debugMode', false)) {
      callback();
      return;
    }

    // Skip progress view updates for consolidated channels
    if (this.useConsolidatedChannel) {
      callback();
      return;
    }

    const hasInfoSpan = /data-message-type="(?:thinking|scratchpad)"/.test(
      message,
    );
    const processedMessage = hasInfoSpan ? message : escapeHtml(message);

    // Detect message type from data-message-type attribute
    const typeMatch = message.match(/data-message-type="(.*?)"/);
    const messageType: MessageType =
      typeMatch && isValidMessageType(typeMatch[1]) ? typeMatch[1] : 'default';

    // Colored format for ProgressView using CSS classes, but with shorter timestamp display
    const isVerbose = getConfig<boolean>('logger.debugMode', false);
    const id = randomUUID();
    const coloredFormattedMessage =
      `<div class="log-line" data-log-id="${id}" ${groupId ? `data-group-id="${groupId}"` : ''} data-full-timestamp="${timestamp}">` +
      `<span class="timestamp" title="${timestamp}">${emoji}${
        isVerbose ? ` [${timeDisplay}]` : ''
      }</span> ` +
      (isVerbose
        ? `<span class="level-${level}">${level
            .toUpperCase()
            .padEnd(8)}</span> `
        : '') +
      `<span class="message-${level}">${processedMessage}</span>` +
      `</div>`;

    // Write to ProgressView if available (with colors and escaped HTML)
    const numericTimestamp = new Date(timestamp).getTime();
    if (this.progressViewProvider) {
      this.progressViewProvider.addLogMessage(
        this.streamName,
        coloredFormattedMessage,
        level as 'error' | 'warn' | 'info' | 'debug',
        groupId,
        numericTimestamp,
        messageType,
        id,
      );
    } else {
      // Buffer the message if ProgressViewProvider is not available
      this.messageBuffer.push({
        id,
        level,
        message: coloredFormattedMessage,
        timestamp: numericTimestamp,
        groupId,
        messageType,
      });
    }

    callback();
  }

  // Method to replay buffered messages when ProgressViewProvider becomes available
  replayBufferedMessages(progressViewProvider: ProgressViewProvider) {
    this.progressViewProvider = progressViewProvider;

    // Skip replay for consolidated channels
    if (this.useConsolidatedChannel) {
      return;
    }

    // First replay any groups
    for (const group of this.groups.values()) {
      this.progressViewProvider.addLogGroup(
        this.streamName,
        group.id,
        group.name,
        group.startTime,
        group.status,
        group.endTime,
      );
    }

    // Then replay messages, which will be associated with their groups
    for (const msg of this.messageBuffer) {
      this.progressViewProvider.addLogMessage(
        this.streamName,
        msg.message,
        msg.level as 'error' | 'warn' | 'info' | 'debug',
        msg.groupId,
        msg.timestamp,
        msg.messageType ?? 'default',
        msg.id,
      );
    }

    this.messageBuffer = []; // Clear buffer after replay
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

    // Skip progress view updates for consolidated channels
    if (this.useConsolidatedChannel) {
      return groupId;
    }

    // Log a message to mark the group start
    if (this.progressViewProvider) {
      this.progressViewProvider.addLogGroup(
        this.streamName,
        groupId,
        groupName,
        now,
        'running',
        undefined, // No end time for a new group
        parentGroupId, // Pass the parent group ID
      );
    }

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

    // Skip progress view updates for consolidated channels
    if (this.useConsolidatedChannel) {
      return;
    }

    if (this.progressViewProvider) {
      this.progressViewProvider.updateLogGroup(
        this.streamName,
        groupId,
        status,
        group.endTime,
      );
    }

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

let globalProgressViewProvider: ProgressViewProvider | undefined;

export function setProgressViewProvider(provider: ProgressViewProvider) {
  globalProgressViewProvider = provider;

  // Replay buffered messages for all existing transports
  for (const transport of channelTransports.values()) {
    transport.replayBufferedMessages(provider);
  }
}

export function initialize(defaultChannel: string): void {
  // Create default logger if it doesn't exist
  if (!channelLoggers.has(defaultChannel)) {
    createLoggerForChannel(defaultChannel);
  }
}

function createLoggerForChannel(channel: string): winston.Logger {
  // Check if channel already exists
  if (channelLoggers.has(channel)) {
    return channelLoggers.get(channel)!;
  }

  const useConsolidatedChannel = shouldUseConsolidatedChannel(channel);

  let outputChannel: vscode.OutputChannel;

  if (useConsolidatedChannel) {
    // Use the main TeXRA output channel for non-agent channels
    outputChannel = getMainOutputChannel();
  } else {
    // Create a separate channel with the TeXRA prefix for agent channels
    const channelName = 'TeXRA ' + channel;
    outputChannel = vscode.window.createOutputChannel(channelName);
  }

  // Create transport
  const transport = new VSCodeTransport(
    outputChannel,
    channel,
    useConsolidatedChannel,
    globalProgressViewProvider,
  );
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
): string {
  const transport = channelTransports.get(channel);
  if (!transport) {
    const logger = createLoggerForChannel(channel);
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
): void {
  const logger = getOrCreateLogger(channel);
  const transport = channelTransports.get(channel);

  // If no groupId provided, use the active group
  const actualGroupId = groupId || transport?.getActiveGroupId();

  // @ts-ignore - We're adding a custom property to the winston log
  logger[level](message, { groupId: actualGroupId });
}

// Simplified logging methods that use channel as channel name
export const debug = (
  channel: string,
  message: string,
  groupId?: string,
): void => {
  logWithGroup(channel, 'debug', message, groupId);
};

export const info = (
  channel: string,
  message: string,
  groupId?: string,
): void => {
  logWithGroup(channel, 'info', message, groupId);
};

export const warn = (
  channel: string,
  message: string,
  groupId?: string,
): void => {
  logWithGroup(channel, 'warn', message, groupId);
};

export const error = (
  channel: string,
  message: string,
  groupId?: string,
): void => {
  logWithGroup(channel, 'error', message, groupId);
};

function getOrCreateLogger(channel: string): winston.Logger {
  if (!channelLoggers.has(channel)) {
    return createLoggerForChannel(channel);
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

// Re-export central emoji mapping for backward compatibility
export { emojis };
