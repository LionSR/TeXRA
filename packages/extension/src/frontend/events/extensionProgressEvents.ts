import type {
  ProgressBackendEvent,
  ProgressBackendEventPayloads,
} from '@shared/progressView/backend/events/ProgressEventHandler';

type ExtensionProgressEventSink = <K extends ProgressBackendEvent>(
  event: K,
  payload: ProgressBackendEventPayloads[K],
) => void;

let activeSink: ExtensionProgressEventSink | undefined;

export function setExtensionProgressEventSink(
  sink: ExtensionProgressEventSink,
): () => void {
  const previous = activeSink;
  activeSink = sink;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (activeSink === sink) activeSink = previous;
  };
}

export function emitExtensionProgressEvent<K extends ProgressBackendEvent>(
  event: K,
  payload: ProgressBackendEventPayloads[K],
): void {
  activeSink?.(event, payload);
}
