import type { StreamTabId } from '@shared/schemas';

/**
 * Which scrollback the transcript paints: the root's history, or a child's
 * own history while a child is focused.
 */
export function activeTranscriptViewport({
  activeStreamId,
  parentId,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentId: StreamTabId | undefined;
}): { readonly key: string; readonly scoped: boolean } {
  return activeStreamId !== undefined && parentId !== undefined
    ? { key: `scoped:${activeStreamId}`, scoped: true }
    : { key: 'root-scrollback', scoped: false };
}
