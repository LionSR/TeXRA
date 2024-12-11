import * as winston from 'winston';
import * as vscode from 'vscode';
import { Writable } from 'stream';

const { combine, timestamp, printf, colorize } = winston.format;

// Define log levels
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Create custom format
const customFormat = printf(({ level, message, timestamp }) => {
  const emoji =
    level === 'error'
      ? '🔴'
      : level === 'warn'
        ? '🟡'
        : level === 'debug'
          ? '🔍'
          : '🟢';
  const upperLevel = level.toUpperCase().padEnd(8);
  return `${emoji} [${timestamp}] ${upperLevel} ${message}`;
});

// Create VSCode output channel transport
class VSCodeTransport extends Writable {
  private channel: vscode.OutputChannel;

  constructor(channel: vscode.OutputChannel) {
    super();
    this.channel = channel;
  }

  write(chunk: any): boolean {
    this.channel.appendLine(chunk.toString().trim());
    return true;
  }
}

const baseFormat = combine(timestamp({ format: 'HH:mm:ss' }), customFormat);

// Map to store loggers for different categories
const channelLoggers = new Map<string, winston.Logger>();

// Map to store output channels
const outputChannels = new Map<string, vscode.OutputChannel>();

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
  const outputChannel = vscode.window.createOutputChannel(
    'CoAuthor: ' + channel,
  );
  outputChannels.set('CoAuthor: ' + channel, outputChannel);

  const format = useColors
    ? combine(
        timestamp({ format: 'HH:mm:ss' }),
        colorize({ all: true }),
        customFormat,
      )
    : baseFormat;

  const logger = winston.createLogger({
    levels: logLevels,
    level: 'debug',
    format,
    transports: [
      new winston.transports.Console({ format }),
      new winston.transports.Stream({
        stream: new VSCodeTransport(outputChannel),
        format: baseFormat,
      }),
    ],
  });

  channelLoggers.set(channel, logger);
  return logger;
}

function getOrCreateLogger(channel: string): winston.Logger {
  if (!channelLoggers.has(channel)) {
    return createLoggerForChannel(channel);
  }
  return channelLoggers.get(channel)!;
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

export function getTimestamp(): string {
  return new Date().toISOString().split('.')[0].replace('T', ' ');
}
