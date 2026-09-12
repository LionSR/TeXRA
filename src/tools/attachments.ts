// Third-party imports
import { Effect } from 'effect';
import { imageSize } from 'image-size';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports
import { ToolError, type ToolFileAttachment } from '@shared/schemas';
import {
  resolveAndFormat,
  type WorkspacePathResolution,
} from '@tools/pathResolution';
import { isNonEmptyString } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getMimeType, isImageMimeType } from '@utils/files/mimeUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toPosixPath } from '@utils/core/pathCore';
import { formatBytes } from '@utils/text/stringUtils';

export interface BuildFileAttachmentOptions {
  /** Path to a workspace file (relative or absolute) */
  filePath: string;
  /** Optional description surfaced to the model */
  description?: string;
  /** Override detected MIME type */
  mimeType?: string;
  /**
   * Pre-resolved path. When provided, skips the internal resolveAndFormat()
   * call — use this to avoid double-resolution when the caller already
   * resolved the path (e.g. ReadTool).
   */
  resolved?: WorkspacePathResolution;
}

const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024; // 15 MiB

/**
 * Max image dimension (px) for many-image API requests.
 * Anthropic returns a non-retryable 400 when any image exceeds this in a
 * multi-image request.
 */
const MANY_IMAGE_MAX_DIMENSION = 2000;

/** Returns true if buffer is an image exceeding the many-image dimension limit. */
function isOversizedImage(buffer: Buffer | Uint8Array): Effect.Effect<boolean> {
  return Effect.try(() => imageSize(buffer)).pipe(
    Effect.map(
      ({ width, height }) =>
        width > MANY_IMAGE_MAX_DIMENSION || height > MANY_IMAGE_MAX_DIMENSION,
    ),
    // Unrecognized or truncated image data — nothing to measure.
    Effect.catch(() => Effect.succeed(false)),
  );
}

/**
 * Preserve a nested ToolError so its message and cause chain survive; wrap
 * anything else in one prefixed with the operation that failed.
 */
const attachmentFailure =
  (errorPrefix: string) =>
  (error: unknown): ToolError =>
    error instanceof ToolError
      ? error
      : new ToolError(`${errorPrefix}: ${toErrorMessage(error)}`, {
          cause: error,
        });

export interface BuildBytesAttachmentOptions {
  /** Display path surfaced to the model. */
  path: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Optional description surfaced to the model. */
  description?: string;
}

/**
 * Package in-memory bytes as a tool attachment.
 *
 * Oversized images are reduced to metadata: their binary data is dropped to
 * prevent non-retryable API 400 errors, and downstream handlers fall back to a
 * read_file hint. The returned attachment owns a copy of `bytes`, so callers
 * may zero their own buffer afterwards.
 */
export const buildBytesAttachment = Effect.fn('buildBytesAttachment')(
  function* ({
    path,
    mimeType,
    bytes,
    description,
  }: BuildBytesAttachmentOptions): Effect.fn.Return<ToolFileAttachment, never> {
    const oversized =
      isImageMimeType(mimeType) && (yield* isOversizedImage(bytes));
    if (oversized) {
      return {
        path,
        mimeType,
        description:
          (description ? `${description}: ` : '') +
          `Image exceeds ${MANY_IMAGE_MAX_DIMENSION}px dimension limit; binary data stripped`,
      };
    }

    return {
      path,
      mimeType,
      bytes: Uint8Array.from(bytes),
      ...(description && { description }),
    };
  },
);

/**
 * Build a tool attachment by reading a workspace file and packaging metadata.
 */
export const buildFileAttachment = Effect.fn('buildFileAttachment')(function* ({
  filePath,
  description,
  mimeType,
  resolved,
}: BuildFileAttachmentOptions): Effect.fn.Return<
  ToolFileAttachment,
  ToolError,
  ToolCall
> {
  const call = yield* ToolCall;
  if (!isNonEmptyString(filePath)) {
    return yield* Effect.fail(
      new ToolError('Attachment path must be provided.'),
    );
  }

  // An unresolvable path rejects with a ToolError the tool runner reports to
  // the model, so it stays a failure rather than becoming a defect.
  const { path, display } = resolved
    ? { path: resolved, display: toPosixPath(resolved.relative) }
    : yield* Effect.try({
        try: () =>
          call.inScope(() => resolveAndFormat(filePath, call.workingDirectory)),
        catch: attachmentFailure(`Failed to resolve attachment ${filePath}`),
      });
  const present = yield* Effect.tryPromise({
    try: () => AbsoluteFS.exists(path.absolute),
    catch: attachmentFailure(`Failed to inspect attachment ${display}`),
  });
  if (!present) {
    return yield* Effect.fail(
      new ToolError(`Attachment not found: ${display}`),
    );
  }

  const stats = yield* Effect.tryPromise({
    try: () => AbsoluteFS.stat(path.absolute),
    catch: attachmentFailure(`Failed to inspect attachment ${display}`),
  });

  if (stats.size > ATTACHMENT_MAX_BYTES) {
    return yield* Effect.fail(
      new ToolError(
        `Attachment ${display} exceeds maximum size of ${formatBytes(ATTACHMENT_MAX_BYTES)}.`,
      ),
    );
  }

  const buffer = yield* Effect.tryPromise({
    try: () => AbsoluteFS.readBytes(path.absolute),
    catch: attachmentFailure(`Failed to read attachment ${display}`),
  });

  const inferredMime =
    mimeType ?? getMimeType(path.fsPath) ?? 'application/octet-stream';

  const attachment = yield* buildBytesAttachment({
    path: display,
    mimeType: inferredMime,
    bytes: buffer,
    description,
  });
  buffer.fill(0);

  return attachment;
});
