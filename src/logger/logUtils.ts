// Third-party imports
import * as vscode from 'vscode';
import * as winston from 'winston';
import Transport from 'winston-transport';

// Local imports - logView
import { LogViewProvider } from './LogViewProvider';
import { getConfig } from '../frontend-utils/commonUtils';

const { combine, timestamp } = winston.format;

// Define log levels
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const emojis = {
  error: '🔴',
  warn: '🟡',
  debug: '🔍',
  info: '🟢',
};

// Group State
interface LogGroup {
  id: string;
  name: string;
  startTime: string;
  endTime?: string;
  status: 'running' | 'error' | 'stopped' | 'ready';
  parentGroupId?: string; // Optional parent group for nested groups
}

// Helper function to escape HTML tags
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Create VSCode output channel transport
class VSCodeTransport extends Transport {
  private channel: vscode.OutputChannel;
  private logViewProvider?: LogViewProvider;
  private streamName: string;
  private messageBuffer: {
    level: string;
    message: string;
    timestamp: string;
    groupId?: string;
  }[] = [];
  private groups: Map<string, LogGroup> = new Map();
  private activeGroupId?: string;

  constructor(
    channel: vscode.OutputChannel,
    streamName: string,
    logViewProvider?: LogViewProvider,
    opts?: Transport.TransportStreamOptions,
  ) {
    super(opts);
    this.channel = channel;
    this.streamName = streamName;
    this.logViewProvider = logViewProvider;
  }

  log(info: any, callback: () => void) {
    const { level, message, timestamp } = info;
    // Use the provided groupId or fall back to the activeGroupId if available
    const groupId = info.groupId || this.activeGroupId;

    const emoji = emojis[level as keyof typeof emojis];

    // Plain format for output channel - no escaping needed
    const formattedMessage = `${emoji} [${timestamp}] ${level.toUpperCase().padEnd(8)} ${message}`;

    // Always write to output channel (plain text)
    this.channel.appendLine(formattedMessage);

    // Skip debug messages in LogView if verbose output is disabled
    if (
      level === 'debug' &&
      !getConfig<boolean>('logger.verboseOutput', false)
    ) {
      callback();
      return;
    }

    // Escape HTML tags in message for LogView
    const escapedMessage = escapeHtml(message);

    // Colored format for LogView using CSS classes
    const coloredFormattedMessage =
      `<div class="log-line" ${groupId ? `data-group-id="${groupId}"` : ''}>` +
      `<span class="timestamp">${emoji} [${timestamp}]</span> ` +
      `<span class="level-${level}">${level.toUpperCase().padEnd(8)}</span> ` +
      `<span class="message-${level}">${escapedMessage}</span>` +
      `</div>`;

    // Write to LogView if available (with colors and escaped HTML)
    if (this.logViewProvider) {
      this.logViewProvider.addLogMessage(
        this.streamName,
        coloredFormattedMessage,
        level as 'error' | 'warn' | 'info' | 'debug',
        groupId,
      );
    } else {
      // Buffer the message if LogViewProvider is not available
      this.messageBuffer.push({
        level,
        message: coloredFormattedMessage,
        timestamp,
        groupId,
      });
    }

    callback();
  }

  // Method to replay buffered messages when LogViewProvider becomes available
  replayBufferedMessages(logViewProvider: LogViewProvider) {
    this.logViewProvider = logViewProvider;

    // First replay any groups
    for (const group of this.groups.values()) {
      this.logViewProvider.addLogGroup(
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
      this.logViewProvider.addLogMessage(
        this.streamName,
        msg.message,
        msg.level as 'error' | 'warn' | 'info' | 'debug',
        msg.groupId,
      );
    }

    this.messageBuffer = []; // Clear buffer after replay
  }

  // Create a new log group and make it active
  startGroup(groupName: string, id?: string, parentGroupId?: string): string {
    const groupId =
      id || `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();
    const timeString = now.toISOString();

    this.groups.set(groupId, {
      id: groupId,
      name: groupName,
      startTime: timeString,
      status: 'running',
      parentGroupId,
    });

    this.activeGroupId = groupId;

    // Log a message to mark the group start
    if (this.logViewProvider) {
      this.logViewProvider.addLogGroup(
        this.streamName,
        groupId,
        groupName,
        timeString,
        'running',
      );
    }

    return groupId;
  }

  // End the current group
  endGroup(groupId: string, status: 'error' | 'stopped' = 'stopped'): void {
    const group = this.groups.get(groupId);
    if (!group) return;

    const now = new Date();
    group.endTime = now.toISOString();
    group.status = status;

    if (this.logViewProvider) {
      this.logViewProvider.updateLogGroup(
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
  getGroup(groupId: string): LogGroup | undefined {
    return this.groups.get(groupId);
  }
}

// Map to store loggers for different categories
const channelLoggers = new Map<string, winston.Logger>();
const channelTransports = new Map<string, VSCodeTransport>();

let globalLogViewProvider: LogViewProvider | undefined;

export function setLogViewProvider(provider: LogViewProvider) {
  globalLogViewProvider = provider;

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

  // Create output channel with the CoAuthor prefix
  const channelName = 'CoAuthor ' + channel;
  const outputChannel = vscode.window.createOutputChannel(channelName);

  // Create transport
  const transport = new VSCodeTransport(
    outputChannel,
    channel,
    globalLogViewProvider,
  );
  channelTransports.set(channel, transport);

  const logger = winston.createLogger({
    levels: logLevels,
    level: 'debug',
    format: combine(
      timestamp({
        format: 'YYYY-MM-DD HH:mm:ss',
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
  id?: string,
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

export { emojis };
