import type { StreamTabId } from '@shared/schemas';

import { activeStreamScope } from './streamViews';

/**
 * The root stream owns ordinary terminal scrollback through Ink `<Static>`.
 * Focused child streams temporarily become that same scrollback owner so their
 * history is visible through native terminal scrollback.
 * Moving between those viewports must redraw from a clean primary buffer so
 * a child page cannot appear under stale root scrollback, and returning to the
 * root can reprint the root static transcript as the active owner.
 */
export function activeTranscriptViewport({
  activeStreamId,
  parentStream,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
}): { readonly key: string; readonly scoped: boolean } {
  const scope = activeStreamScope({ activeStreamId, parentStream });
  return scope.kind === 'child'
    ? { key: `scoped:${scope.streamId}`, scoped: true }
    : { key: 'root-scrollback', scoped: false };
}
