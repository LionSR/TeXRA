// Third-party imports
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

// Local imports - progressView
import { bus } from '@eventBus/ProgressEventBus';
import { getConfig } from '@utils/config';
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';
import type { TaskGroup, LogMessageData } from './LogTypes';
import { MESSAGE_TYPES, type MessageType } from './messageTypes';

export const EMOJI_BY_LEVEL: Record<string, string> = {
  error: '🔴',
  warn: '🟡',
  info: '🟢',
  debug: '🔍',
};

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface ChannelLogger {
  readonly channelId: string;
  readonly isAgentChannel: boolean;
  debug(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void;
  info(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void;
  warn(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void;
  error(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void;
  fileList(files: unknown[], groupId?: string): void;
  missingOutputs(info: unknown, groupId?: string): void;
  latexDiff(results: unknown[], groupId?: string): void;
  statistics(stats: ExtendedTokenUsageStats, groupId?: string): void;
  userMessage(message: string, groupId?: string): void;
  startGroup(
    groupName: string,
    id?: string,
    parentGroupId?: string,
  ): Promise<string>;
  endGroup(groupId: string, status?: 'error' | 'stopped'): void;
  getActiveGroupId(): string | undefined;
  setActiveGroupId(groupId: string | undefined): void;
}

export interface ChannelLoggerOptions {
  isAgent?: boolean;
}

interface ChannelState {
  outputChannel: vscode.OutputChannel;
  streamName: string;
  isAgentChannel: boolean;
  groups: Map<string, TaskGroup>;
  activeGroupId?: string;
}

interface LogParams {
  groupId?: string;
  messageType?: MessageType;
  data?: unknown;
}

function isValidMessageType(type: unknown): type is MessageType {
  return Object.values(MESSAGE_TYPES).includes(type as MessageType);
}

function serializeLogData(data: unknown): unknown {
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  return data;
}

let mainOutputChannel: vscode.OutputChannel | null = null;

function getMainOutputChannel(): vscode.OutputChannel {
  if (!mainOutputChannel) {
    mainOutputChannel = vscode.window.createOutputChannel('TeXRA');
  }
  return mainOutputChannel;
}

const channelStates = new Map<string, ChannelState>();

function ensureChannel(
  channel: string,
  isAgentOverride?: boolean,
): ChannelState {
  const existing = channelStates.get(channel);
  if (existing) {
    return existing;
  }

  const isAgentChannel = isAgentOverride ?? false;
  const outputChannel = isAgentChannel
    ? vscode.window.createOutputChannel(`TeXRA ${channel}`)
    : getMainOutputChannel();

  const state: ChannelState = {
    outputChannel,
    streamName: channel,
    isAgentChannel,
    groups: new Map(),
  };

  channelStates.set(channel, state);
  return state;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number, length = 2) =>
    value.toString().padStart(length, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
  return `${datePart} ${timePart}`;
}

function writeToOutputChannel(
  state: ChannelState,
  level: LogLevel,
  message: string,
  timestamp: Date,
  structuredData: unknown,
): void {
  const emoji = getColorForLevel(level);
  const timestampLabel = formatTimestamp(timestamp);
  const channelPrefix = state.isAgentChannel ? '' : `[${state.streamName}] `;
  const formattedMessage = `${emoji} [${timestampLabel}] ${channelPrefix}${message}`;
  state.outputChannel.appendLine(formattedMessage);

  if (
    structuredData !== undefined &&
    getConfig<boolean>('logger.debugMode', false)
  ) {
    const dataString =
      typeof structuredData === 'string'
        ? structuredData
        : JSON.stringify(structuredData, null, 2);
    state.outputChannel.appendLine(dataString);
  }
}

function shouldEmitToProgressView(
  state: ChannelState,
  level: LogLevel,
  messageType?: MessageType,
): boolean {
  if (level === 'debug' && !getConfig<boolean>('logger.debugMode', false)) {
    return false;
  }

  if (messageType === MESSAGE_TYPES.INTERNAL) {
    return false;
  }

  return state.isAgentChannel;
}

function emitToProgressView(
  state: ChannelState,
  level: LogLevel,
  message: string,
  timestamp: Date,
  groupId: string | undefined,
  messageType: MessageType | undefined,
  structuredData: unknown,
): void {
  const type = isValidMessageType(messageType)
    ? messageType
    : MESSAGE_TYPES.DEFAULT;
  const verbose = getConfig<boolean>('logger.debugMode', false);
  const logMessage: LogMessageData = {
    id: randomUUID(),
    text: message,
    level,
    timestamp: timestamp.getTime(),
    groupId,
    messageType: type,
    verbose,
    data: structuredData,
  };

  bus.emit('addLogMessage', {
    stream: state.streamName,
    logMessage,
  });
}

function logMessage(
  channel: string,
  level: LogLevel,
  message: string,
  params: LogParams = {},
  isAgentOverride?: boolean,
): void {
  const state = ensureChannel(channel, isAgentOverride);
  const structuredData = serializeLogData(params.data);
  const now = new Date();
  const groupId = params.groupId ?? state.activeGroupId;

  writeToOutputChannel(state, level, message, now, structuredData);

  if (!shouldEmitToProgressView(state, level, params.messageType)) {
    return;
  }

  emitToProgressView(
    state,
    level,
    message,
    now,
    groupId,
    params.messageType,
    structuredData,
  );
}

export function initialize(channel: string, isAgent = false): void {
  ensureChannel(channel, isAgent);
}

export function getColorForLevel(level: string): string {
  return EMOJI_BY_LEVEL[level.toLowerCase()] ?? '•';
}

export const debug = (
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void => {
  logMessage(
    channel,
    'debug',
    message,
    { groupId, messageType, data },
    isAgent,
  );
};

export const info = (
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void => {
  logMessage(channel, 'info', message, { groupId, messageType, data }, isAgent);
};

export const warn = (
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void => {
  logMessage(channel, 'warn', message, { groupId, messageType, data }, isAgent);
};

export const error = (
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void => {
  logMessage(
    channel,
    'error',
    message,
    { groupId, messageType, data },
    isAgent,
  );
};

export function logFileList(
  channel: string,
  files: unknown[],
  groupId?: string,
  isAgent = false,
): void {
  const count = files.length;
  const summary = `Loaded ${count} file${count === 1 ? '' : 's'}`;
  info(channel, summary, groupId, MESSAGE_TYPES.FILE_LIST, isAgent, files);
}

export function logMissingOutputs(
  channel: string,
  infoData: unknown,
  groupId?: string,
  isAgent = false,
): void {
  const missing =
    (typeof infoData === 'object' && infoData !== null
      ? (infoData as { missing?: unknown[] }).missing
      : undefined) ?? [];
  const count = missing.length;
  const summary = `${count} output file${count === 1 ? '' : 's'} missing`;
  info(
    channel,
    summary,
    groupId,
    MESSAGE_TYPES.MISSING_OUTPUTS,
    isAgent,
    infoData,
  );
}

export function logLatexDiff(
  channel: string,
  results: unknown[],
  groupId?: string,
  isAgent = false,
): void {
  const summary = `Latexdiff results: ${results.length}`;
  info(channel, summary, groupId, MESSAGE_TYPES.LATEXDIFF, isAgent, results);
}

export function logStatistics(
  channel: string,
  stats: ExtendedTokenUsageStats,
  groupId?: string,
  isAgent = false,
): void {
  const summary = `Usage - input: ${stats.inputTokens ?? 0}, output: ${stats.outputTokens ?? 0}`;
  debug(channel, summary, groupId, MESSAGE_TYPES.STATISTICS, isAgent, stats);
}

export function logUserMessage(
  channel: string,
  message: string,
  groupId?: string,
  isAgent = false,
): void {
  info(channel, message, groupId, MESSAGE_TYPES.USER_MESSAGE, isAgent);
}

export const fileList = logFileList;
export const missingOutputs = logMissingOutputs;
export const latexDiff = logLatexDiff;
export const statistics = logStatistics;
export const userMessage = logUserMessage;

export function startGroup(
  channel: string,
  groupName: string,
  id: string = randomUUID(),
  parentGroupId?: string,
  isAgent = false,
): string {
  const state = ensureChannel(channel, isAgent);
  const now = Date.now();
  const groupId = id;

  state.groups.set(groupId, {
    id: groupId,
    name: groupName,
    startTime: now,
    status: 'running',
    parentGroupId,
  });

  state.activeGroupId = groupId;

  if (!state.isAgentChannel) {
    return groupId;
  }

  bus.emit('addTaskGroup', {
    stream: state.streamName,
    groupId,
    groupName,
    startTime: now,
    status: 'running',
    endTime: undefined,
    parentGroupId,
  });

  return groupId;
}

export function endGroup(
  channel: string,
  groupId: string,
  status: 'error' | 'stopped' = 'stopped',
): void {
  const state = channelStates.get(channel);
  if (!state) {
    return;
  }

  const group = state.groups.get(groupId);
  if (!group) {
    return;
  }

  const now = Date.now();
  group.endTime = now;
  group.status = status;

  if (state.isAgentChannel) {
    bus.emit('updateTaskGroup', {
      stream: state.streamName,
      groupId,
      status,
      endTime: group.endTime,
    });
  }

  if (state.activeGroupId === groupId) {
    state.activeGroupId = group.parentGroupId;
  }
}

export function getActiveGroupId(channel: string): string | undefined {
  return channelStates.get(channel)?.activeGroupId;
}

export function setActiveGroupId(
  channel: string,
  groupId: string | undefined,
): void {
  const state = channelStates.get(channel);
  if (!state) {
    return;
  }

  if (groupId === undefined || state.groups.has(groupId)) {
    state.activeGroupId = groupId;
  }
}

export function createChannelLogger(
  channelId: string,
  options: ChannelLoggerOptions = {},
): ChannelLogger {
  const { isAgent = false } = options;
  ensureChannel(channelId, isAgent);

  return {
    channelId,
    isAgentChannel: isAgent,
    debug: (message, groupId, messageType, data) =>
      debug(channelId, message, groupId, messageType, isAgent, data),
    info: (message, groupId, messageType, data) =>
      info(channelId, message, groupId, messageType, isAgent, data),
    warn: (message, groupId, messageType, data) =>
      warn(channelId, message, groupId, messageType, isAgent, data),
    error: (message, groupId, messageType, data) =>
      error(channelId, message, groupId, messageType, isAgent, data),
    fileList: (files, groupId) =>
      logFileList(channelId, files, groupId, isAgent),
    missingOutputs: (infoData, groupId) =>
      logMissingOutputs(channelId, infoData, groupId, isAgent),
    latexDiff: (results, groupId) =>
      logLatexDiff(channelId, results, groupId, isAgent),
    statistics: (stats, groupId) =>
      logStatistics(channelId, stats, groupId, isAgent),
    userMessage: (message, groupId) =>
      logUserMessage(channelId, message, groupId, isAgent),
    startGroup: async (groupName, id, parentGroupId) =>
      startGroup(channelId, groupName, id, parentGroupId, isAgent),
    endGroup: (groupId, status) => endGroup(channelId, groupId, status),
    getActiveGroupId: () => getActiveGroupId(channelId),
    setActiveGroupId: (groupId) => setActiveGroupId(channelId, groupId),
  };
}

export function parseLegacyLogData(
  logMessage: LogMessageData,
  logger?: ChannelLogger,
  forceParse = false,
): unknown | undefined {
  if (!forceParse && logMessage.data !== undefined) {
    return logMessage.data;
  }

  const type = logMessage.messageType;
  const legacyTypes = new Set<string>([
    MESSAGE_TYPES.FILE_LIST,
    MESSAGE_TYPES.MISSING_OUTPUTS,
    MESSAGE_TYPES.LATEXDIFF,
    MESSAGE_TYPES.STATISTICS,
  ]);

  if (type && legacyTypes.has(type) && logMessage.text) {
    try {
      const parsed = JSON.parse(logMessage.text);
      if (typeof parsed === 'object' && parsed !== null) {
        logMessage.data = parsed;
        return parsed;
      }
    } catch (error) {
      logger?.warn(
        `Failed to parse legacy log data: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return undefined;
}

export function getTimestamp(): string {
  return new Date()
    .toLocaleString('en-US', {
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    .replace(',', '');
}
