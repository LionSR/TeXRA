// Standard library imports
import { EventEmitter } from 'events';

// Maximum number of events to buffer when no listeners are registered
const MAX_BUFFER_SIZE = 1000;

export type ProgressEvent =
  | 'addLogMessage'
  | 'updateLogMessage'
  | 'addTaskGroup'
  | 'updateTaskGroup'
  | 'setActiveStream'
  | 'updateStreamStatus'
  | 'addOutputFiles'
  | 'updateMissingOutputs'
  | 'clearMissingOutputs'
  | 'clearOutputFiles'
  | 'setTaskState'
  | 'updateGroupUsage'
  | 'clearTaskOutput'
  | 'updateStreamUsage';

class ProgressEventBus {
  private emitter = new EventEmitter();
  private buffer: { event: ProgressEvent; payload: any }[] = [];

  emit(event: ProgressEvent, payload: any): void {
    if (this.emitter.listenerCount(event) === 0) {
      this.buffer.push({ event, payload });
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        this.buffer.shift();
      }
    } else {
      this.emitter.emit(event, payload);
    }
  }

  on(event: ProgressEvent, listener: (payload: any) => void): () => void {
    this.emitter.on(event, listener);
    const remaining: typeof this.buffer = [];
    for (const item of this.buffer) {
      if (item.event === event) {
        listener(item.payload);
      } else {
        remaining.push(item);
      }
    }
    this.buffer = remaining;
    return () => this.emitter.off(event, listener);
  }
}

export const bus = new ProgressEventBus();
