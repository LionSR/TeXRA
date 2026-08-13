// Local imports - shared types
import type { StreamTabId } from '@shared/schemas';
import type { ExtractedClipboardImage } from '@shared/utils/clipboardImages';

/**
 * Non-persisted follow-up image state for one stream.
 *
 * Follow-up text remains in `ToolUseStreamState.ui.followUpText`, the
 * canonical stream state used by both the extension and desktop renderers.
 * Image bytes and promises cannot live in that Zod-backed state, so this
 * module gives them the same stream-keyed ownership without serializing them.
 */
export interface FollowUpInputTransientState {
  pendingImages: ExtractedClipboardImage[];
  pendingImagePastes: Set<Promise<void>>;
  imagePasteRevision: number;
  sendAfterImagePastes: boolean;
}

const stateByStream = new Map<StreamTabId, FollowUpInputTransientState>();

/** Return the stable transient-state object owned by `streamId`. */
export function getFollowUpInputTransientState(
  streamId: StreamTabId,
): FollowUpInputTransientState {
  const existing = stateByStream.get(streamId);
  if (existing) return existing;

  const created: FollowUpInputTransientState = {
    pendingImages: [],
    pendingImagePastes: new Set(),
    imagePasteRevision: 0,
    sendAfterImagePastes: false,
  };
  stateByStream.set(streamId, created);
  return created;
}

/** Invalidate pending work and empty one stream's follow-up image draft. */
export function resetFollowUpInputTransientState(
  state: FollowUpInputTransientState,
): void {
  state.imagePasteRevision += 1;
  state.pendingImages = [];
  state.pendingImagePastes.clear();
  state.sendAfterImagePastes = false;
}

/** Remove a deleted stream's image draft and invalidate late paste work. */
export function deleteFollowUpInputTransientState(streamId: StreamTabId): void {
  const state = stateByStream.get(streamId);
  if (!state) return;
  resetFollowUpInputTransientState(state);
  stateByStream.delete(streamId);
}

/** Clear every image draft when the progress frontend is reset. */
export function clearFollowUpInputTransientStateStore(): void {
  for (const state of stateByStream.values()) {
    resetFollowUpInputTransientState(state);
  }
  stateByStream.clear();
}
