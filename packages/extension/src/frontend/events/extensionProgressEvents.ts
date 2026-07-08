import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@agent/runtime/hostProgressEvents';

type ExtensionProgressEventSink = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
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

export function emitExtensionProgressEvent<K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
): void {
  activeSink?.(event, payload);
}
