// Standard library imports
import { Writable } from 'stream';

// Third-party imports
import * as vscode from 'vscode';
import * as winston from 'winston';

// Local imports - logView
import { LogViewProvider } from './LogViewProvider';

const { combine, timestamp, printf, json } = winston.format;

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

// Create custom format
const customFormat = printf(({ level, message, timestamp }) => {
  const emoji = emojis[level as keyof typeof emojis];
  const upperLevel = level.toUpperCase().padEnd(8);
  return `${emoji} [${timestamp}] ${upperLevel} ${message}`;
});

// Create VSCode output channel transport
class VSCodeTransport extends Writable {
  private channel: vscode.OutputChannel;
  private logViewProvider?: LogViewProvider;
  private streamName: string;

  constructor(
    channel: vscode.OutputChannel,
    streamName: string,
    logViewProvider?: LogViewProvider,
  ) {
    super();
    this.channel = channel;
    this.streamName = streamName;
    this.logViewProvider = logViewProvider;
  }

  write(chunk: any): boolean {
    const info = JSON.parse(chunk);
    const { level, message, timestamp } = info;
    const emoji = emojis[level as keyof typeof emojis];
    const formattedMessage = `${emoji} [${timestamp}] ${level.toUpperCase().padEnd(8)} ${message}`;

    // Always write to output channel
    this.channel.appendLine(formattedMessage);

    // Write to LogView
    if (this.logViewProvider) {
      this.logViewProvider.addLogMessage(
        this.streamName,
        formattedMessage,
        level as 'error' | 'warn' | 'info' | 'debug',
      );
    }
    return true;
  }
}

// Map to store loggers for different categories
const channelLoggers = new Map<string, winston.Logger>();

// Map to store output channels
const outputChannels = new Map<string, vscode.OutputChannel>();

let globalLogViewProvider: LogViewProvider | undefined;

export function setLogViewProvider(provider: LogViewProvider) {
  globalLogViewProvider = provider;
  // Recreate all existing loggers with the new provider
  for (const [channel, logger] of channelLoggers.entries()) {
    const newLogger = createLoggerForChannel(channel, false);
    channelLoggers.set(channel, newLogger);
  }
}

export function initializeLogging(
  defaultChannel: string,
  useColors: boolean = false,
): void {
  // Create default output channel if it doesn't exist
  if (!outputChannels.has(defaultChannel)) {
    createLoggerForChannel(defaultChannel, useColors);
  }
}

function createLoggerForChannel(
  channel: string,
  useColors: boolean = false,
): winston.Logger {
  // Check if channel already exists
  if (channelLoggers.has(channel)) {
    return channelLoggers.get(channel)!;
  }

  const outputChannel = vscode.window.createOutputChannel(
    'CoAuthor: ' + channel,
  );
  outputChannels.set('CoAuthor: ' + channel, outputChannel);

  const logger = winston.createLogger({
    levels: logLevels,
    level: 'debug',
    format: combine(
      timestamp({
        format: 'YYYY-MM-DD HH:mm:ss',
      }),
      json(),
    ),
    transports: [
      new winston.transports.Stream({
        stream: new VSCodeTransport(
          outputChannel,
          channel,
          globalLogViewProvider,
        ),
      }),
    ],
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
