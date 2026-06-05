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
