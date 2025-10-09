// Local imports - event bus
import type {
  StreamStatus as ProgressStreamStatus,
  StreamStatusOrReady as ProgressStreamStatusOrReady,
} from '@eventBus/ProgressEventBus';

export type StreamStatusType = ProgressStreamStatus;
export type StreamStatusOrReadyType = ProgressStreamStatusOrReady;
export type StatusType = ProgressStreamStatusOrReady;
