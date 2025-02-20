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
  }[] = [];

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
      `<div class="log-line">` +
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
      );
    } else {
      // Buffer the message if LogViewProvider is not available
      this.messageBuffer.push({
        level,
        message: coloredFormattedMessage,
        timestamp,
      });
    }

    callback();
  }

  // Method to replay buffered messages when LogViewProvider becomes available
  replayBufferedMessages(logViewProvider: LogViewProvider) {
    this.logViewProvider = logViewProvider;
    for (const msg of this.messageBuffer) {
      this.logViewProvider.addLogMessage(
        this.streamName,
        msg.message,
        msg.level as 'error' | 'warn' | 'info' | 'debug',
      );
    }
    this.messageBuffer = []; // Clear buffer after replay
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

// Simplified logging methods that use channel as channel name
export const debug = (channel: string, message: string): void => {
  getOrCreateLogger(channel).debug(message);
};

export const info = (channel: string, message: string): void => {
  getOrCreateLogger(channel).info(message);
};

export const warn = (channel: string, message: string): void => {
  getOrCreateLogger(channel).warn(message);
};

export const error = (channel: string, message: string): void => {
  getOrCreateLogger(channel).error(message);
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
      year: 'numeric',
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
