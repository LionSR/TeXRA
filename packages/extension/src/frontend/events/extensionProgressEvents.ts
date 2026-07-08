import type {
  ProgressBackendInteractionEvent,
  ProgressBackendInteractionPayloads,
} from '@shared/progressView/backend/events/ProgressInteractionHandler';

type ExtensionProgressEventSink = <K extends ProgressBackendInteractionEvent>(
  event: K,
  payload: ProgressBackendInteractionPayloads[K],
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

export function emitExtensionProgressEvent<
  K extends ProgressBackendInteractionEvent,
>(event: K, payload: ProgressBackendInteractionPayloads[K]): void {
  activeSink?.(event, payload);
}
