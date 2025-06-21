import { EventEmitter } from 'events';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type MessageType = 'default' | 'scratchpad' | 'thinking';
export type StatusType = 'running' | 'error' | 'stopped' | 'ready';

export interface LogMessageEvent {
  stream: string;
  message: string;
  level: LogLevel;
  groupId?: string;
  timestamp: number;
  messageType: MessageType;
}

export interface AddGroupEvent {
  stream: string;
  groupId: string;
  groupName: string;
  startTime: number;
  status: StatusType;
  endTime?: number;
  parentGroupId?: string;
}

export interface UpdateGroupEvent {
  stream: string;
  groupId: string;
  status: StatusType;
  endTime?: number;
}

interface EventMap {
  log: LogMessageEvent;
  addGroup: AddGroupEvent;
  updateGroup: UpdateGroupEvent;
}

class AgentEventBus extends EventEmitter {
  private buffer: { event: keyof EventMap; payload: any }[] = [];

  emitEvent<E extends keyof EventMap>(event: E, payload: EventMap[E]): void {
    if (this.listenerCount(event) === 0) {
      this.buffer.push({ event, payload });
    }
    this.emit(event, payload);
  }

  on<E extends keyof EventMap>(
    event: E,
    listener: (payload: EventMap[E]) => void,
  ): this {
    super.on(event, listener);
    const remaining: typeof this.buffer = [];
    for (const item of this.buffer) {
      if (item.event === event) {
        listener(item.payload);
      } else {
        remaining.push(item);
      }
    }
    this.buffer = remaining;
    return this;
  }
}

export const agentEventBus = new AgentEventBus();
