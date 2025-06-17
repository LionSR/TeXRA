// Standard library imports
import { EventEmitter } from 'events';

// Local imports - types
import { LogGroup } from '@/types/LogTypes';
import type { TokenUsageStats } from '@/types/UsageTypes';
import type { OutputFileInfo } from '@/types/FileInfoTypes';
import type { TaskState } from './TaskState';

export interface LogMessageEvent {
  stream: string;
  message: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  groupId?: string;
  timestamp: number;
  messageType: 'default' | 'scratchpad' | 'thinking';
}

export interface LogGroupEvent {
  stream: string;
  group: LogGroup;
}

export interface LogGroupUpdateEvent {
  stream: string;
  groupId: string;
  status: 'error' | 'stopped';
  endTime: number;
}

export interface StreamStatusEvent {
  stream: string;
  status: 'running' | 'stopped' | 'error';
}

export interface TaskStateEvent {
  streamId: string;
  state: TaskState;
}

export interface OutputFilesEvent {
  stream: string;
  filesByRound: { [key: number]: OutputFileInfo[] };
}

export interface GroupUsageEvent {
  stream: string;
  groupId: string;
  usage: TokenUsageStats;
}

export const agentEventBus = new EventEmitter();
