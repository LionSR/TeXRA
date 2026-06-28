import type { StreamTabId } from '@shared/schemas';

export interface ProgressRuntimeSession {
  retainInterruptStreams(streams: Iterable<StreamTabId>): void;
  flushPendingTraces(): void;
}

export const defaultProgressRuntimeSession: ProgressRuntimeSession = {
  retainInterruptStreams: () => undefined,
  flushPendingTraces: () => undefined,
};
