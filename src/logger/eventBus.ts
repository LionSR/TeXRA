// Standard library imports
import { EventEmitter } from 'events';

// Local imports - types
import { LogGroup } from '@/types/LogTypes';

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

export const agentEventBus = new EventEmitter();
