// Local imports - shared types
import type { StreamTabId } from '@shared/schemas';
import type { ExtractedClipboardImage } from '@shared/utils/clipboardImages';

/**
 * Live follow-up image state for one stream.
 *
 * Follow-up text remains in `ToolUseStreamState.ui.followUpText`, the
 * canonical stream state used by both the extension and desktop renderers.
 * Image promises cannot live in that Zod-backed state, so this module owns the
 * live objects while followUpDraftPersistence snapshots their settled bytes.
 */
export interface FollowUpInputTransientState {
  pendingImages: ExtractedClipboardImage[];
  pendingImagePastes: Set<Promise<void>>;
  imagePasteRevision: number;
  sendAfterImagePastes: boolean;
}

const stateByStream = new Map<StreamTabId, FollowUpInputTransientState>();

/** Deterministic immutable-content fingerprint that survives document reload. */
export function fingerprintFollowUpImage(
  image: ExtractedClipboardImage,
): string {
  const value = `${image.fileName}\0${image.mediaType}\0${image.base64}`;
  let firstHash = 2166136261;
  let secondHash = 3339675911;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    firstHash = Math.imul(firstHash ^ code, 16777619);
    secondHash = Math.imul(secondHash ^ code, 16777619);
  }
  const formatHash = (hash: number): string =>
    (hash >>> 0).toString(16).padStart(8, '0');
  return [
    image.base64.length,
    formatHash(firstHash),
    formatHash(secondHash),
  ].join(':');
}

/** Capture the images whose tokens remain in the submitted text. */
export function followUpAttachmentSnapshot(
  text: string,
  images: readonly ExtractedClipboardImage[],
): {
  images: ExtractedClipboardImage[];
  fingerprints: string[];
} {
  const attached = images.filter((image) =>
    text.includes(`[${image.fileName}]`),
  );
  return {
    images: attached,
    fingerprints: attached.map(fingerprintFollowUpImage),
  };
}

/** Compare ordered attachment snapshots that contribute to delivery identity. */
export function followUpAttachmentFingerprintsMatch(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((fingerprint, index) => fingerprint === right[index])
  );
}

/** Remove only images captured by an accepted delivery snapshot. */
export function removeAcceptedFollowUpImages(
  state: FollowUpInputTransientState,
  acceptedFingerprints: readonly string[],
): void {
  const accepted = new Set(acceptedFingerprints);
  state.pendingImages = state.pendingImages.filter(
    (image) => !accepted.has(fingerprintFollowUpImage(image)),
  );
}

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
