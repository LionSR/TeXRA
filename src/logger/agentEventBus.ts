import { EventEmitter } from 'events';
import type {
  LogEvent,
  LogGroupEvent,
  UpdateLogGroupEvent,
} from '../types/LogTypes';

class AgentEventBus extends EventEmitter {
  private logBuffer: LogEvent[] = [];
  private groupBuffer: LogGroupEvent[] = [];
  private updateBuffer: UpdateLogGroupEvent[] = [];

  emitLog(event: LogEvent): void {
    if (this.listenerCount('log') === 0) {
      this.logBuffer.push(event);
    } else {
      this.emit('log', event);
    }
  }

  emitAddGroup(event: LogGroupEvent): void {
    if (this.listenerCount('addGroup') === 0) {
      this.groupBuffer.push(event);
    } else {
      this.emit('addGroup', event);
    }
  }

  emitUpdateGroup(event: UpdateLogGroupEvent): void {
    if (this.listenerCount('updateGroup') === 0) {
      this.updateBuffer.push(event);
    } else {
      this.emit('updateGroup', event);
    }
  }

  onLog(listener: (event: LogEvent) => void): void {
    this.logBuffer.forEach(listener);
    this.logBuffer = [];
    this.on('log', listener);
  }

  onAddGroup(listener: (event: LogGroupEvent) => void): void {
    this.groupBuffer.forEach(listener);
    this.groupBuffer = [];
    this.on('addGroup', listener);
  }

  onUpdateGroup(listener: (event: UpdateLogGroupEvent) => void): void {
    this.updateBuffer.forEach(listener);
    this.updateBuffer = [];
    this.on('updateGroup', listener);
  }
}

const agentEventBus = new AgentEventBus();
export default agentEventBus;
export type { LogEvent, LogGroupEvent, UpdateLogGroupEvent };
