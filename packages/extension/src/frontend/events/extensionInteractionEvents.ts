import type {
  ProgressBackendInteractionEvent,
  ProgressBackendInteractionPayloads,
} from '@controllers/progressView/backend/events/ProgressInteractionHandler';

type ExtensionInteractionEventSink = <
  K extends ProgressBackendInteractionEvent,
>(
  event: K,
  payload: ProgressBackendInteractionPayloads[K],
) => void;

let activeSink: ExtensionInteractionEventSink | undefined;

export function setExtensionInteractionEventSink(
  sink: ExtensionInteractionEventSink,
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

export function emitExtensionInteractionEvent<
  K extends ProgressBackendInteractionEvent,
>(event: K, payload: ProgressBackendInteractionPayloads[K]): void {
  activeSink?.(event, payload);
}
