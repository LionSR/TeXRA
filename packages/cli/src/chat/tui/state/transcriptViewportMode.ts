import type { StreamTabId } from '@shared/schemas';

export const ROOT_SCROLLBACK_VIEWPORT_KEY = 'root-scrollback';

/**
 * The root stream owns ordinary terminal scrollback through Ink `<Static>`.
 * Focused child streams own a scoped, self-contained transcript surface.
 * Explicit transcript viewers also own a scoped surface, even when focus stays
 * on the parent stream.
 * Moving between those viewports must redraw from a clean primary buffer so
 * a child page cannot appear under stale root scrollback, and returning to the
 * root can reprint the root static transcript as the active owner.
 */
export function transcriptViewportKey({
  activeStreamId,
  parentStream,
  transcriptViewerStreamId,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly transcriptViewerStreamId?: StreamTabId;
}): string {
  if (transcriptViewerStreamId) return `viewer:${transcriptViewerStreamId}`;
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
}

export interface TranscriptViewportRepaintOptions {
  readonly clearScrollback: boolean;
  readonly preserveStatic: false;
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
  return { previousViewportKey, nextViewportKey };
}

export function transcriptViewportRepaintOptions(
  _change: TranscriptViewportChange,
): TranscriptViewportRepaintOptions {
  return {
    clearScrollback: true,
    preserveStatic: false,
  };
}
