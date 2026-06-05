import type { StreamTabId } from '@shared/schemas';

export const ROOT_SCROLLBACK_VIEWPORT_KEY = 'root-scrollback';

export function transcriptViewportKey({
  activeStreamId,
  parentStream,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
}): string {
  return activeStreamId && parentStream.has(activeStreamId)
    ? `scoped:${activeStreamId}`
    : ROOT_SCROLLBACK_VIEWPORT_KEY;
}

export function isScopedTranscriptViewport(viewportKey: string): boolean {
  return viewportKey !== ROOT_SCROLLBACK_VIEWPORT_KEY;
}

export interface TranscriptViewportChange {
  readonly previousViewportKey: string;
  readonly nextViewportKey: string;
  readonly enteredRootScrollback: boolean;
}

export function transcriptViewportChange({
  nextViewportKey,
  previousViewportKey,
}: {
  readonly nextViewportKey: string;
  readonly previousViewportKey: string | undefined;
}): TranscriptViewportChange | undefined {
  if (previousViewportKey === undefined) return undefined;
  if (previousViewportKey === nextViewportKey) return undefined;
  return {
    previousViewportKey,
    nextViewportKey,
    enteredRootScrollback:
      isScopedTranscriptViewport(previousViewportKey) &&
      !isScopedTranscriptViewport(nextViewportKey),
  };
}
