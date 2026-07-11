import type { MediaAttachmentKind } from '@shared/schemas';

const ATTACHMENT_MARKER_TYPE_BY_KIND = {
  image: 'image',
  document: 'document',
} as const satisfies Record<MediaAttachmentKind, string>;

interface AttachmentMarkerContentBlock {
  type: (typeof ATTACHMENT_MARKER_TYPE_BY_KIND)[MediaAttachmentKind];
}

/** Build the byte-free content block used to mark an archived attachment. */
export function mediaAttachmentKindToContentBlock(
  kind: MediaAttachmentKind,
): AttachmentMarkerContentBlock {
  return { type: ATTACHMENT_MARKER_TYPE_BY_KIND[kind] };
}
