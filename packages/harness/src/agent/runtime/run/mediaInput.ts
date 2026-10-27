/**
 * Media input for the run loop: attached files become the package's
 * base64 input parts, gated by what the bound model accepts. The package
 * models media in the request; this is the one place file bytes are read.
 *
 * Failure policy: a file the model cannot take is skipped with a transcript
 * warning; a file that cannot be read or classified fails the read. The
 * caller decides what a failed read means for its message: the run loop
 * fails the opening message loudly (a task's revision included),
 * and a follow-up batch is restored to its queue with the failure
 * reported. Nothing drops an attachment silently.
 */
import { Cause, Effect, Exit, FileSystem } from 'effect';

import type { AgentTrace } from '@agent/trace';
import type { ConfigProvider } from '@platform/interfaces';
import {
  fileLocationDisplayPath,
  type FileLocation,
  type MediaAttachmentKind,
  type StoredMediaPart,
  type ToolFileAttachment,
  type ToolResultPayload,
} from '@shared/schemas';
import type { DraftBlob } from '@shared/session/historyTurns';
import { blobAddress } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { getExtensionLowercase } from '@utils/core/pathCore';
import { getMimeType, isImageMimeType } from '@utils/files/mimeUtils';
import { getBase64EncodedMedia, processPdf2Png } from '@utils/media/img';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { MessageSchema } from '@texra-ai/llm';

/** One element of a canonical user or tool-result message. */
export type InputPart = Extract<
  typeof MessageSchema.Type,
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
): Effect.fn.Return<
  MediaInputParts,
  Error,
  FileSystem.FileSystem | ChildProcessSpawner
> {
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
    // after this branch, never before, so a PDF the image tool cannot read still
    // reaches a model that could read it.
    if (capabilities.supportsNativePdf) {
      const base64 = yield* getBase64EncodedMedia(path, config);
      return {
        parts: [{ kind: 'document', mimeType: 'application/pdf', base64 }],
        kinds: ['document'],
      };
    }
    const { pages, pageCount } = yield* processPdf2Png(path).pipe(
      Effect.mapError(
        (cause) =>
          new Error(
            `Failed to process PDF file as image: ${display}: ${cause.message}`,
            { cause },
          ),
      ),
    );
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
): Effect.fn.Return<
  MediaInputParts,
  Error,
  FileSystem.FileSystem | ChildProcessSpawner
> {
  // Files load at once; the parts keep the attachment order.
  const loaded = yield* Effect.forEach(
    locations,
    (location) => partsForFile(location, capabilities, logger, config),
    { concurrency: 4 },
  );
  return {
    parts: loaded.flatMap((file) => file.parts),
    kinds: loaded.flatMap((file) => file.kinds),
  };
});

/**
 * Bytes the store holds under `digest` (a captured attachment), as the
 * history's part naming them, or null when the binding carries no such
 * attachment inline. Null is a degradation the model can't see, so the
 * caller names it in the transcript. An upload is no way around it: a file
 * id only ever stands in for bytes the binding already takes.
 */
export function storedMediaPart(
  mimeType: string,
  digest: string,
  capabilities: MediaCapabilities,
): StoredMediaPart | null {
  if (mimeType === 'application/pdf') {
    return capabilities.supportsVision && capabilities.supportsNativePdf
      ? { kind: 'document', mimeType, digest }
      : null;
  }
  if (isImageMimeType(mimeType)) {
    return capabilities.supportsVision
      ? { kind: 'image', mimeType, digest }
      : null;
  }
  if (mimeType.startsWith('audio/')) {
    return capabilities.supportsNativeAudio
      ? { kind: 'audio', mimeType, digest }
      : null;
  }
  return null;
}

/**
 * Attachment bytes captured as immutable content before the result commits:
 * from the tool's own payload when it carried one, from the path otherwise,
 * each stored under its address with the result's row; one a script relays
 * by address is linked. A capture failure records the omission and its
 * reason.
 */
export const captureAttachments = Effect.fn('toolUse.captureAttachments')(
  function* (
    attachments: readonly ToolFileAttachment[],
    workspaceRoot: string | undefined,
  ): Effect.fn.Return<
    {
      readonly attachments: ToolResultPayload['attachments'];
      readonly blobs: readonly DraftBlob[];
    },
    never,
    FileSystem.FileSystem
  > {
    const fs = yield* FileSystem.FileSystem;
    const captured: ToolResultPayload['attachments'][number][] = [];
    const blobs: DraftBlob[] = [];
    for (const attachment of attachments) {
      const base = {
        path: attachment.path,
        mimeType: attachment.mimeType,
        ...(attachment.description !== undefined
          ? { description: attachment.description }
          : {}),
      };
      if (attachment.digest !== undefined) {
        blobs.push({ digest: attachment.digest });
        captured.push({
          ...base,
          content: { kind: 'stored', digest: attachment.digest },
        });
        continue;
      }
      const inline =
        attachment.base64Data ||
        Buffer.from(attachment.bytes ?? []).toString('base64');
      const read =
        inline !== ''
          ? Exit.succeed(inline)
          : yield* Effect.exit(
              fs
                .readFile(
                  pathToLocationIn(workspaceRoot, attachment.path).absolutePath,
                )
                .pipe(Effect.map((b) => Buffer.from(b).toString('base64'))),
            );
      if (Exit.isSuccess(read)) {
        const digest = blobAddress(read.value);
        blobs.push({ digest, text: read.value });
        captured.push({ ...base, content: { kind: 'stored', digest } });
      } else
        captured.push({
          ...base,
          content: {
            kind: 'metadata-only',
            reason: toErrorMessage(Cause.squash(read.cause)),
          },
        });
    }
    return { attachments: captured, blobs };
  },
);
