/**
 * Media input for the run loop: attached files become the package's
 * base64 input parts, gated by what the bound model accepts. The package
 * models media in the request; this is the one place file bytes are read.
 *
 * Failure policy: a file the model cannot take is skipped with a transcript
 * warning; a file that cannot be read or classified fails the read. The
 * caller decides what a failed read means for its message: the tool-use
 * loop fails the opening message loudly, the reflection loop warns and
 * continues, and a follow-up batch is restored to its queue with the failure
 * reported. Nothing drops an attachment silently.
 */
import { Effect, FileSystem } from 'effect';

import type { AgentTrace } from '@agent/trace';
import type { MessageSchema } from '@llm/turn';
import type { ConfigProvider } from '@platform/interfaces';
import {
  fileLocationDisplayPath,
  type FileLocation,
  type MediaAttachmentKind,
} from '@shared/schemas';
import { getExtensionLowercase } from '@utils/core/pathCore';
import { getMimeType, isImageMimeType } from '@utils/files/mimeUtils';
import {
  countPdfPages,
  getBase64EncodedMedia,
  processPdf2Png,
} from '@utils/media/img';
import type { z } from 'zod';

/** One element of a canonical user or tool-result message. */
export type InputPart = Extract<
  z.infer<typeof MessageSchema>,
  { role: 'user' }
>['content'][number];

interface MediaCapabilities {
  readonly supportsVision: boolean;
  readonly supportsNativePdf: boolean;
  readonly supportsNativeAudio: boolean;
}

interface MediaInputParts {
  readonly parts: readonly InputPart[];
  /** What was inserted, for the transcript's attachment badges. */
  readonly kinds: readonly MediaAttachmentKind[];
}

/**
 * Read one media file into input parts. A PDF is a native document when the
 * model accepts one, page images otherwise; audio only where the model takes
 * it natively. A file the model cannot take is skipped with a transcript
 * warning, never silently.
 */
const partsForFile = Effect.fn('mediaInput.file')(function* (
  location: FileLocation,
  capabilities: MediaCapabilities,
  logger: AgentTrace,
  config: ConfigProvider,
): Effect.fn.Return<MediaInputParts, Error, FileSystem.FileSystem> {
  const path = location.absolutePath;
  const display = fileLocationDisplayPath(location);
  const mimeType = getMimeType(path);
  const ext = getExtensionLowercase(path);
  if (ext === '.pdf') {
    if (!capabilities.supportsVision) {
      logger.warn(`Skipping ${display}: the model does not accept documents.`);
      return { parts: [], kinds: [] };
    }
    // A model that takes a PDF natively is handed the file's bytes as they
    // are, so the local page count is only needed to rasterize: it is read
    // after this branch, never before, so a PDF pdf-lib cannot parse still
    // reaches a model that could read it.
    if (capabilities.supportsNativePdf) {
      const base64 = yield* getBase64EncodedMedia(path, config);
      return {
        parts: [{ kind: 'document', mimeType: 'application/pdf', base64 }],
        kinds: ['document'],
      };
    }
    const pageCount = yield* countPdfPages(path);
    if (pageCount === 0) {
      return yield* Effect.fail(
        new Error(`Failed to process PDF file as image: ${display}`),
      );
    }
    const pages = yield* processPdf2Png(path);
    if (pages === null) {
      return yield* Effect.fail(
        new Error(`Failed to process PDF file as image: ${display}`),
      );
    }
    if (pages.length < pageCount) {
      logger.warn(
        `Attached only pages 1-${pages.length} of ${pageCount} from ${display}`,
      );
    }
    return {
      parts: pages.map((base64) => ({
        kind: 'image',
        mimeType: 'image/png',
        base64,
      })),
      kinds: ['document'],
    };
  }
  if (mimeType !== null && mimeType.startsWith('audio/')) {
    if (!capabilities.supportsNativeAudio) {
      logger.warn(`Skipping ${display}: the model does not accept audio.`);
      return { parts: [], kinds: [] };
    }
    const base64 = yield* getBase64EncodedMedia(path, config);
    return { parts: [{ kind: 'audio', mimeType, base64 }], kinds: [] };
  }
  if (!isImageMimeType(mimeType) || mimeType === null) {
    return yield* Effect.fail(
      new Error(
        `Unsupported media file: ${display} (${ext || 'no extension'})`,
      ),
    );
  }
  if (!capabilities.supportsVision) {
    logger.warn(`Skipping ${display}: the model does not accept images.`);
    return { parts: [], kinds: [] };
  }
  const base64 = yield* getBase64EncodedMedia(path, config);
  return { parts: [{ kind: 'image', mimeType, base64 }], kinds: ['image'] };
});

/**
 * Input parts for a list of attached files, in order. `config` is the
 * configuration of the run's own session, held as data: the image size limit
 * answers for that project, not for whichever roots the calling fiber carries.
 */
export const mediaInputParts = Effect.fn('mediaInput')(function* (
  locations: readonly FileLocation[],
  capabilities: MediaCapabilities,
  logger: AgentTrace,
  config: ConfigProvider,
): Effect.fn.Return<MediaInputParts, Error, FileSystem.FileSystem> {
  const parts: InputPart[] = [];
  const kinds: MediaAttachmentKind[] = [];
  for (const location of locations) {
    const loaded = yield* partsForFile(location, capabilities, logger, config);
    parts.push(...loaded.parts);
    kinds.push(...loaded.kinds);
  }
  return { parts, kinds };
});

/**
 * A base64 payload already in hand, as the part the package lowers, or null
 * when the binding carries no such attachment inline. Null is a degradation
 * the model can't see, so the caller names it in the transcript. An upload
 * is no way around it: a file id only ever stands in for bytes the binding
 * already takes.
 */
export function inlineMediaPart(
  mimeType: string,
  base64: string,
  capabilities: MediaCapabilities,
): InputPart | null {
  if (mimeType === 'application/pdf') {
    return capabilities.supportsVision && capabilities.supportsNativePdf
      ? { kind: 'document', mimeType, base64 }
      : null;
  }
  if (isImageMimeType(mimeType)) {
    return capabilities.supportsVision
      ? { kind: 'image', mimeType, base64 }
      : null;
  }
  if (mimeType.startsWith('audio/')) {
    return capabilities.supportsNativeAudio
      ? { kind: 'audio', mimeType, base64 }
      : null;
  }
  return null;
}
