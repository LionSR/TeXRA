import type { MediaAttachmentKind } from '@shared/schemas';

/** Build the byte-free content block used to mark an archived attachment. */
export function mediaAttachmentKindToContentBlock(kind: MediaAttachmentKind): {
  type: MediaAttachmentKind;
} {
  return { type: kind };
}
