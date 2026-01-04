// Standard library imports
import * as path from 'path';

// Third-party imports
import { Minimatch } from 'minimatch';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - tools
import { ToolError, type ToolFileAttachment } from '@tools/result';

// Local imports - core utilities
import { getPathSegments, isNonEmptyString, toPosixPath } from '@utils/core';
import { WorkspaceFS, getMimeType } from '@utils/files';

export interface WorkspacePathResolution {
  relative: string;
  absolute: string;
}

/**
 * Resolve a potentially absolute or relative path against the workspace root.
 *
 * The returned relative path is normalized and guaranteed to remain inside the
 * workspace. Throws if the workspace folder cannot be determined or if the
 * resolved location would escape the workspace root.
 */
export function resolveWorkspaceRelativePath(
  targetPath?: string,
): WorkspacePathResolution {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    throw new ToolError('Workspace path is not available.');
  }

  if (!targetPath || targetPath.trim() === '' || targetPath === '.') {
    return {
      relative: '.',
      absolute: workspacePath,
    };
  }

  const trimmed = targetPath.trim();
  const absoluteCandidate = path.resolve(workspacePath, trimmed);
  const relativeCandidate = path.relative(workspacePath, absoluteCandidate);
  const normalizedRelative =
    relativeCandidate === '' ? '.' : path.normalize(relativeCandidate);

  // Use centralized path segment extraction
  const segments = getPathSegments(normalizedRelative);
  if (segments.includes('..')) {
    throw new ToolError('Path must stay within the workspace.');
  }

  return {
    relative: normalizedRelative,
    absolute: absoluteCandidate,
  };
}

/**
 * Join a workspace-relative base path with a child segment and ensure the
 * result stays within the workspace root.
 */
export function joinWorkspaceRelativePath(
  baseRelative: string,
  child: string,
): WorkspacePathResolution {
  const base = baseRelative && baseRelative !== '.' ? baseRelative : '.';
  const combined = base === '.' ? child : path.join(base, child);
  return resolveWorkspaceRelativePath(combined);
}

/**
 * Compile a glob pattern into a matcher that operates on POSIX-style paths.
 * Supports `*`, `?`, and `**` tokens.
 */
export function createGlobMatcher(pattern: string): (value: string) => boolean {
  const matcher = new Minimatch(pattern, {
    dot: true,
    matchBase: true,
    nocase: false,
  });

  return (value: string) => matcher.match(value.replaceAll('\\', '/'));
}

// Re-export gitignore utilities from standalone module
export { getGitignoreMatcher, clearGitignoreCache } from './gitignore';
export type { GitignoreMatcher } from './gitignore';

/**
 * Format tool output with a header and content.
 */
export function formatToolOutput(
  header: string,
  content: string | string[] | null,
  noMatchesText: string = '(no entries)',
): string {
  if (!content || (Array.isArray(content) && content.length === 0)) {
    return `${header}\n${noMatchesText}`;
  }
  const lines = Array.isArray(content) ? content.join('\n') : content;
  return `${header}\n${lines}`;
}

/**
 * Common pattern for resolving and formatting workspace paths.
 */
export function resolveAndFormat(path?: string): {
  resolved: WorkspacePathResolution;
  display: string;
} {
  const resolved = resolveWorkspaceRelativePath(path);
  const display = toPosixPath(resolved.relative);
  return { resolved, display };
}

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
}

const DEFAULT_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024; // 15 MiB

/**
 * Build a tool attachment by reading a workspace file and packaging metadata.
 */
export async function buildFileAttachment({
  filePath,
  description,
  mimeType,
  includeBase64 = false,
  maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES,
}: BuildFileAttachmentOptions): Promise<ToolFileAttachment> {
  if (!isNonEmptyString(filePath)) {
    throw new ToolError('Attachment path must be provided.');
  }

  const { resolved, display } = resolveAndFormat(filePath);
  const exists = await WorkspaceFS.exists(resolved.relative);
  if (!exists) {
    throw new ToolError(`Attachment not found: ${display}`);
  }

  let stats: { size: number } | undefined;
  try {
    stats = await WorkspaceFS.stat(resolved.relative);
  } catch (err) {
    throw new ToolError(
      `Failed to inspect attachment ${display}: ${toErrorMessage(err)}`,
    );
  }

  if (stats.size > maxBytes) {
    const limitMb = (maxBytes / (1024 * 1024)).toFixed(1);
    throw new ToolError(
      `Attachment ${display} exceeds maximum size of ${limitMb} MiB.`,
    );
  }

  let buffer: Buffer;
  try {
    buffer = await WorkspaceFS.readFileBytes(resolved.relative);
  } catch (err) {
    throw new ToolError(
      `Failed to read attachment ${display}: ${toErrorMessage(err)}`,
    );
  }

  const inferredMime =
    mimeType ?? getMimeType(resolved.relative) ?? 'application/octet-stream';

  const base64Payload = includeBase64 ? buffer.toString('base64') : undefined;
  const bytes = Uint8Array.from(buffer);
  buffer.fill(0);

  const attachment: ToolFileAttachment = {
    path: display,
    mimeType: inferredMime,
    bytes,
  };

  if (description) {
    attachment.description = description;
  }
  if (base64Payload) {
    attachment.base64Data = base64Payload;
  }

  return attachment;
}
