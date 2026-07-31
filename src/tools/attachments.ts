// Local imports
import { ToolError, type ToolFileAttachment } from '@shared/schemas/toolResult';
import { isOversizedImage, MANY_IMAGE_MAX_DIMENSION } from '@tools/imageUtils';
import {
  resolveAndFormat,
  type WorkspacePathResolution,
} from '@tools/pathResolution';
import { wrapApiCall } from '@tools/utils';
import { isNonEmptyString } from '@utils/core';
import { WorkspaceFS, getMimeType } from '@utils/files';
import { toPosixPath } from '@utils/core/pathCore';

export interface BuildFileAttachmentOptions {
  /** Path to a workspace file (relative or absolute) */
  filePath: string;
  /** Optional description surfaced to the model */
  description?: string;
  /** Override detected MIME type */
  mimeType?: string;
  /** Include base64 data in the attachment */
  includeBase64?: boolean;
  /** Maximum allowed file size in bytes */
  maxBytes?: number;
  /** Optional root directory override (e.g. a git worktree) */
  root?: string;
  /**
   * Pre-resolved path. When provided, skips the internal resolveAndFormat()
   * call — use this to avoid double-resolution when the caller already
   * resolved the path (e.g. ReadTool).
   */
  resolved?: WorkspacePathResolution;
}

const DEFAULT_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024; // 15 MiB

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
export function buildBytesAttachment({
  path,
  mimeType,
  bytes,
  description,
}: BuildBytesAttachmentOptions): ToolFileAttachment {
  if (mimeType.startsWith('image/') && isOversizedImage(bytes)) {
    return {
      path,
      mimeType,
      description:
        (description ? `${description} — ` : '') +
        `Image exceeds ${MANY_IMAGE_MAX_DIMENSION}px dimension limit; binary data stripped`,
    };
  }

  return {
    path,
    mimeType,
    bytes: Uint8Array.from(bytes),
    ...(description && { description }),
  };
}

/**
 * Build a tool attachment by reading a workspace file and packaging metadata.
 */
export async function buildFileAttachment({
  filePath,
  description,
  mimeType,
  includeBase64 = false,
  maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES,
  root,
  resolved,
}: BuildFileAttachmentOptions): Promise<ToolFileAttachment> {
  if (!isNonEmptyString(filePath)) {
    throw new ToolError('Attachment path must be provided.');
  }

  const { path, display } = resolved
    ? { path: resolved, display: toPosixPath(resolved.relative) }
    : resolveAndFormat(filePath, root);
  const exists = await WorkspaceFS.exists(path.fsPath);
  if (!exists) {
    throw new ToolError(`Attachment not found: ${display}`);
  }

  const stats = await wrapApiCall(
    () => WorkspaceFS.stat(path.fsPath),
    `Failed to inspect attachment ${display}`,
  );

  if (stats.size > maxBytes) {
    const limitMb = (maxBytes / (1024 * 1024)).toFixed(1);
    throw new ToolError(
      `Attachment ${display} exceeds maximum size of ${limitMb} MiB.`,
    );
  }

  const buffer = await wrapApiCall(
    () => WorkspaceFS.readBytes(path.fsPath),
    `Failed to read attachment ${display}`,
  );

  const inferredMime =
    mimeType ?? getMimeType(path.fsPath) ?? 'application/octet-stream';

  const attachment = buildBytesAttachment({
    path: display,
    mimeType: inferredMime,
    bytes: buffer,
    description,
  });
  const base64Data =
    includeBase64 && attachment.bytes ? buffer.toString('base64') : undefined;
  buffer.fill(0);

  return base64Data ? { ...attachment, base64Data } : attachment;
}
