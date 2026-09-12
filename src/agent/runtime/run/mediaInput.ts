/**
 * Media input for the run loop: attached files become the package's
 * base64 input parts, gated by what the bound model accepts. The package
 * models media in the request; this is the one place file bytes are read.
 */
import { Effect } from 'effect';

import type { AgentTrace } from '@agent/trace';
import type { MessageSchema } from '@llm/turn';
import {
  fileLocationDisplayPath,
  type FileLocation,
  type MediaAttachmentKind,
} from '@shared/schemas';
import { getExtensionLowercase } from '@utils/core/pathCore';
import { ensureError } from '@utils/errors/errorMessage';
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

export interface MediaCapabilities {
  readonly supportsVision: boolean;
  readonly supportsNativePdf: boolean;
  readonly supportsNativeAudio: boolean;
}

export interface MediaInputParts {
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
  inScope: <A>(operation: () => A) => A,
): Effect.fn.Return<MediaInputParts, Error> {
  const path = location.absolutePath;
  const display = fileLocationDisplayPath(location);
  const mimeType = getMimeType(path);
  const ext = getExtensionLowercase(path);
  if (ext === '.pdf') {
    if (!capabilities.supportsVision) {
      logger.warn(`Skipping ${display}: the model does not accept documents.`);
      return { parts: [], kinds: [] };
    }
    const pageCount = yield* Effect.tryPromise({
      try: () => countPdfPages(path),
      catch: ensureError,
    });
    if (pageCount === 0) {
      return yield* Effect.fail(
        new Error(`Failed to process PDF file as image: ${display}`),
      );
    }
    if (capabilities.supportsNativePdf) {
      const base64 = yield* Effect.tryPromise({
        try: () => getBase64EncodedMedia(path),
        catch: ensureError,
      });
      return {
        parts: [{ kind: 'document', mimeType: 'application/pdf', base64 }],
        kinds: ['document'],
      };
    }
    const pages = yield* Effect.tryPromise({
      try: () => processPdf2Png(path),
      catch: ensureError,
    });
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
    const base64 = yield* Effect.tryPromise({
      try: () => getBase64EncodedMedia(path),
      catch: ensureError,
    });
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
  const base64 = yield* Effect.tryPromise({
    try: () => getBase64EncodedMedia(path),
    catch: ensureError,
  });
  return { parts: [{ kind: 'image', mimeType, base64 }], kinds: ['image'] };
});

/** Input parts for a list of attached files, in order. */
export const mediaInputParts = Effect.fn('mediaInput')(function* (
  locations: readonly FileLocation[],
  capabilities: MediaCapabilities,
  logger: AgentTrace,
  inScope: <A>(operation: () => A) => A,
): Effect.fn.Return<MediaInputParts, Error> {
  const parts: InputPart[] = [];
  const kinds: MediaAttachmentKind[] = [];
  for (const location of locations) {
    const loaded = yield* partsForFile(location, capabilities, logger, inScope);
    parts.push(...loaded.parts);
    kinds.push(...loaded.kinds);
  }
  return { parts, kinds };
});

/**
 * A base64 payload already in hand, as the part the package lowers, or null
 * when the binding carries no such attachment inline. Null is a degradation
 * the model can't see, so the caller names it in the transcript: the package
 * takes inline bytes only (`InputPartSchema`), so there is no by-reference
 * lowering to fall back to.
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
