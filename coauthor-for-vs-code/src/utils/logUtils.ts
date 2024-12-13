import * as winston from 'winston';
import * as vscode from 'vscode';
import { Writable } from 'stream';
import { LogViewProvider } from '../logView/logViewProvider';

const { combine, timestamp, printf } = winston.format;

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
  info: '🟢'
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
  private level: 'error' | 'warn' | 'info' | 'debug';

  constructor(
    channel: vscode.OutputChannel, 
    streamName: string, 
    level: 'error' | 'warn' | 'info' | 'debug',
    logViewProvider?: LogViewProvider
  ) {
    super();
    this.channel = channel;
    this.streamName = streamName;
    this.level = level;
    this.logViewProvider = logViewProvider;
  }

  write(chunk: any): boolean {
    const formattedMessage = chunk.toString().trim();
    this.channel.appendLine(formattedMessage);
    if (this.logViewProvider) {
      this.logViewProvider.addLogMessage(this.streamName, formattedMessage, this.level);
    }
    return true;
  }
}

const baseFormat = combine(timestamp({ format: 'HH:mm:ss' }), customFormat);

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
    format: baseFormat,
    transports: [
      new winston.transports.Console({ format: baseFormat }),
      new winston.transports.Stream({
        stream: new VSCodeTransport(outputChannel, channel, 'error', globalLogViewProvider),
        format: baseFormat,
        level: 'error',
      }),
      new winston.transports.Stream({
        stream: new VSCodeTransport(outputChannel, channel, 'warn', globalLogViewProvider),
        format: baseFormat,
        level: 'warn',
      }),
      new winston.transports.Stream({
        stream: new VSCodeTransport(outputChannel, channel, 'info', globalLogViewProvider),
        format: baseFormat,
        level: 'info',
      }),
      new winston.transports.Stream({
        stream: new VSCodeTransport(outputChannel, channel, 'debug', globalLogViewProvider),
        format: baseFormat,
        level: 'debug',
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
  return new Date().toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit',
    second: '2-digit'
  });
}

export { emojis };
