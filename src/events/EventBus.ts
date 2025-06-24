import { EventEmitter } from 'events';

export interface LogMessageEvent {
  stream: string;
  message: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  groupId?: string;
  timestamp: number;
  messageType: 'default' | 'scratchpad' | 'thinking';
  id: string;
}

export interface LogGroupEvent {
  stream: string;
  groupId: string;
  groupName: string;
  startTime: number;
  status: 'running' | 'error' | 'stopped';
  endTime?: number;
  parentGroupId?: string;
}

export interface UpdateLogGroupEvent {
  stream: string;
  groupId: string;
  status: 'running' | 'error' | 'stopped';
  endTime?: number;
}

export interface TaskStatusChangeEvent {
  stream: string;
  status: string;
}

export type EventTypes =
  | 'logMessage'
  | 'addLogGroup'
  | 'updateLogGroup'
  | 'taskStatusChange';

export class EventBus {
  private emitter = new EventEmitter();
  private buffers: Record<string, any[]> = {};

  emit(event: EventTypes, payload: any): void {
    if (this.emitter.listenerCount(event) === 0) {
      if (!this.buffers[event]) {
        this.buffers[event] = [];
      }
      this.buffers[event].push(payload);
    }
    this.emitter.emit(event, payload);
  }

  on(event: EventTypes, listener: (payload: any) => void): void {
    // Replay buffered events if any
    if (this.buffers[event]) {
      for (const payload of this.buffers[event]) {
        listener(payload);
      }
      delete this.buffers[event];
    }
    this.emitter.on(event, listener);
  }

  off(event: EventTypes, listener: (payload: any) => void): void {
    this.emitter.off(event, listener);
  }
}

export const eventBus = new EventBus();
