import { EventEmitter } from 'events';

export type ProgressEvent =
  | 'addLogMessage'
  | 'updateLogMessage'
  | 'addLogGroup'
  | 'updateLogGroup'
  | 'setActiveStream'
  | 'updateStreamStatus'
  | 'addOutputFiles'
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
    } else {
      this.emitter.emit(event, payload);
    }
  }

  on(event: ProgressEvent, listener: (payload: any) => void): void {
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
  }
}

const bus = new ProgressEventBus();

export const emitProgress = (event: ProgressEvent, payload: any): void => {
  bus.emit(event, payload);
};

export const onProgress = (
  event: ProgressEvent,
  listener: (payload: any) => void,
): void => {
  bus.on(event, listener);
};
