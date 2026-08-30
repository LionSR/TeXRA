import { getMimeType } from '@utils/files/mimeUtils';
import type { ModelCapabilities } from 'llm-zoo';

type MediaVisionWarningKind = 'attached' | 'pasted';

/**
 * The warning to log when media files will be dropped because the chosen model
 * lacks vision, or `undefined` when nothing is dropped (vision is supported, or
 * every media file is audio the model can take natively).
 */
export function mediaNeedsVisionWarning(
  mediaFiles: readonly string[] | undefined,
  capabilities: Pick<ModelCapabilities, 'supportsVision'>,
  kind: MediaVisionWarningKind,
  modelName?: string,
): string | undefined {
  if (capabilities.supportsVision) return undefined;
  const count =
    mediaFiles?.filter(
      (filePath) => !getMimeType(filePath)?.startsWith('audio/'),
    ).length ?? 0;
  if (count === 0) return undefined;

  const subject = modelName ? `Model "${modelName}"` : 'Model';
  return (
    `${subject} has no vision support: ${count} ${kind} ` +
    `${count === 1 ? 'media file is' : 'media files are'} not sent to the model. ` +
    `Switch to a vision-capable model to use ${count === 1 ? 'it' : 'them'}.`
  );
}
