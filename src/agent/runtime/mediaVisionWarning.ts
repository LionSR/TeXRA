import type { MediaAttachmentKind } from '@shared/schemas';
import { getMimeType } from '@utils/files';
import type { ModelCapabilities } from 'llm-zoo';

type MediaVisionWarningKind = 'attached' | 'pasted';

function needsVision(filePath: string): boolean {
  return !getMimeType(filePath)?.startsWith('audio/');
}

/**
 * Classify each attached media file as `image` or `document` (everything
 * non-image) by its MIME type — the same coarse split
 * `normalizeConversationForExport` renders attachment markers for. Feeds the
 * `userMessage` transcript row's attachment markers (#7508): kind + count
 * only, never bytes.
 */
export function mediaAttachmentKinds(
  mediaFiles: readonly string[] | undefined,
): MediaAttachmentKind[] {
  return (mediaFiles ?? []).map((filePath) =>
    getMimeType(filePath)?.startsWith('image/') ? 'image' : 'document',
  );
}

export function countMediaFilesNeedingVision(
  mediaFiles: readonly string[] | undefined,
): number {
  return mediaFiles?.filter(needsVision).length ?? 0;
}

export function shouldWarnMediaNeedsVision(
  mediaFiles: readonly string[] | undefined,
  capabilities: Pick<ModelCapabilities, 'supportsVision'>,
): boolean {
  return (
    countMediaFilesNeedingVision(mediaFiles) > 0 && !capabilities.supportsVision
  );
}

export function formatMediaNeedsVisionWarning(
  count: number,
  kind: MediaVisionWarningKind,
  modelName?: string,
): string {
  const subject = modelName ? `Model "${modelName}"` : 'Model';
  return (
    `${subject} has no vision support — ${count} ${kind} ` +
    `${count === 1 ? 'media file is' : 'media files are'} not sent to the model. ` +
    `Switch to a vision-capable model to use ${count === 1 ? 'it' : 'them'}.`
  );
}
