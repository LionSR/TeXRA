// Standard library imports
import * as path from 'path';

// Third-party imports
import { Minimatch } from 'minimatch';
import { z } from 'zod';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - tools
import { isOversizedImage, MANY_IMAGE_MAX_DIMENSION } from '@tools/imageUtils';
import { ToolError, type ToolFileAttachment } from '@tools/result';

// Local imports - core utilities
import { isNonEmptyString } from '@utils/core';
import { WorkspaceFS, getMimeType } from '@utils/files';
import { locatePathInRoot } from '@utils/files/workspaceRoot';
import { toPosixPath } from '@utils/core/pathCore';

export interface WorkspacePathResolution {
  relative: string;
  absolute: string;
  /**
   * The path to pass to filesystem operations.
   * Absolute when operating outside the workspace (e.g. a worktree),
   * workspace-relative otherwise (for WorkspaceFS compatibility).
   */
  fsPath: string;
}

/**
 * Shared Zod schema field for the optional `working_directory` parameter.
 * Use in tool schemas: `working_directory: WorkingDirectorySchema`.
 */
export const WorkingDirectorySchema = z
  .string()
  .nullish()
  .describe(
    'Absolute path to operate in (e.g. a git worktree). Defaults to workspace root.',
  );

/** Trim a working_directory input to a clean string or undefined. */
export function parseWorkingDirectory(
  raw: string | null | undefined,
): string | undefined {
  return raw?.trim() || undefined;
}

/**
 * Resolve a potentially absolute or relative path against a root directory.
 *
 * When `root` is provided, paths are resolved against that directory instead
 * of the workspace root. This supports operating in git worktrees or other
 * directories outside the main workspace.
 *
 * Thin policy wrapper around WorkspaceFS.locatePath() / locatePathInRoot()
 * that throws ToolError when the path escapes the root. Tools use this;
 * non-tool code should call WorkspaceFS.locatePath() directly.
 */
export function resolveWorkspaceRelativePath(
  targetPath?: string,
  root?: string,
): WorkspacePathResolution {
  const trimmed = targetPath?.trim();
  const input = !trimmed || trimmed === '.' ? '' : trimmed;

  if (root) {
    // Absolute paths need special handling — locatePathInRoot only works with relative paths.
    if (input && path.isAbsolute(input)) {
      const relative = path.relative(root, input);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new ToolError('Path must stay within the working directory.');
      }
      return { relative: relative || '.', absolute: input, fsPath: input };
    }
    const resolved = locatePathInRoot(root, input);
    if (resolved.kind === 'external') {
      throw new ToolError('Path must stay within the working directory.');
    }
    const relative = resolved.relativePath || '.';
    return { relative, absolute: resolved.absolutePath, fsPath: resolved.absolutePath };
  }

  if (!WorkspaceFS.getPath()) {
    throw new ToolError('Workspace path is not available.');
  }

  const resolved = WorkspaceFS.locatePath(input);

  if (resolved.kind === 'external') {
    throw new ToolError('Path must stay within the workspace.');
  }

  const relative = resolved.relativePath || '.';
  return { relative, absolute: resolved.absolutePath, fsPath: relative };
}

/**
 * Join a workspace-relative base path with a child segment and ensure the
 * result stays within the root directory.
 */
export function joinWorkspaceRelativePath(
  baseRelative: string,
  child: string,
  root?: string,
): WorkspacePathResolution {
  // path.join handles empty/dot bases naturally: join('.', 'x') and join('', 'x') both return 'x'
  return resolveWorkspaceRelativePath(
    path.join(baseRelative || '.', child),
    root,
  );
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

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Returns 0 for empty needles.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Maximum lines returned in a single file view before truncation. */
export const READ_FILE_MAX_LINES = 2000;

/** Default width for line number padding */
const LINE_NUMBER_WIDTH = 6;

/**
 * Format lines with line numbers for display in tool output.
 * @param lines - Array of lines to format
 * @param startingLine - 1-based line number for the first line (default: 1)
 * @param width - Padding width for line numbers (default: 6)
 * @returns Array of formatted lines with line number prefix and tab separator
 */
export function formatLinesWithNumbers(
  lines: string[],
  startingLine: number = 1,
  width: number = LINE_NUMBER_WIDTH,
): string[] {
  return lines.map((line, index) => {
    const lineNumber = startingLine + index;
    const prefix = lineNumber.toString().padStart(width, ' ');
    return `${prefix}\t${line}`;
  });
}

// ============================================================================
// Shared file-view formatting
// ============================================================================

export interface FileViewOptions {
  /** Display path used in the summary (e.g., "src/foo.ts" or "/memories/notes.md"). */
  path: string;
  /** All lines of the file. */
  lines: string[];
  /**
   * Optional 1-based `[start, end]` (both inclusive) line range.
   * When omitted or nullish, the full file is shown.
   * Values are clamped to the file bounds automatically.
   */
  viewRange?: [number, number] | null;
  /** Max visible lines before truncation. Defaults to READ_FILE_MAX_LINES (2000). */
  maxLines?: number;
  /** Optional suffix appended to the summary (e.g., memory metadata). */
  summarySuffix?: string;
}

export interface FileViewResult {
  [key: string]: unknown;
  output: string;
  summary: string;
}

/**
 * Shared pipeline for displaying file content with line numbers, truncation,
 * and a standardised "Read …" summary.  Used by read_file, text_editor view,
 * memory view, and executions readFile.
 */
export function formatFileView({
  path: filePath,
  lines,
  viewRange,
  maxLines = READ_FILE_MAX_LINES,
  summarySuffix = '',
}: FileViewOptions): FileViewResult {
  const totalLines = lines.length;
  const rangeProvided = viewRange != null;
  const startLine = Math.max(viewRange?.[0] ?? 1, 1);
  const endLine = Math.min(viewRange?.[1] ?? totalLines, totalLines);
  const rangeSize = Math.max(endLine - startLine + 1, 0);
  const truncated = rangeSize > maxLines;
  const sliceEnd = startLine - 1 + Math.min(rangeSize, maxLines);
  const visibleLines = lines.slice(startLine - 1, sliceEnd);
  const visibleCount = visibleLines.length;

  // -- output ---------------------------------------------------------------
  const segments: string[] = [];
  if (visibleLines.length > 0) {
    segments.push(formatLinesWithNumbers(visibleLines, startLine).join('\n'));
  }
  if (truncated) {
    segments.push(`...(truncated, ${rangeSize - maxLines} more lines)`);
  }

  // -- summary --------------------------------------------------------------
  let summary: string;

  if (visibleCount === 0) {
    const reason =
      totalLines === 0 ? 'file is empty' : 'no lines in requested range';
    summary = `Read ${filePath} (${reason})`;
  } else {
    const lastVisibleLine = startLine + visibleCount - 1;
    const isFullRead =
      !rangeProvided &&
      !truncated &&
      startLine === 1 &&
      lastVisibleLine === totalLines;

    if (isFullRead) {
      summary = `Read ${filePath}`;
    } else {
      const rangeLabel =
        startLine === lastVisibleLine
          ? `line ${startLine}`
          : `lines ${startLine}-${lastVisibleLine}`;
      summary = `Read ${rangeLabel} of ${filePath}`;
    }
  }

  if (summarySuffix) {
    summary += summarySuffix;
  }

  return { output: segments.join('\n'), summary };
}

/**
 * Pluralize a word based on count.
 * Returns the singular form for count === 1, plural form otherwise.
 */
export function pluralize(
  count: number,
  singular: string,
  plural?: string,
): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/**
 * Format a result count with proper pluralization.
 * Example: formatResultCount(3, 'result') returns "3 results"
 */
export function formatResultCount(
  count: number,
  singular: string,
  plural?: string,
): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}

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
  const body = Array.isArray(content) ? content.join('\n') : content;
  return `${header}\n${body}`;
}

/**
 * Common pattern for resolving and formatting paths.
 * Returns `path` (resolution with relative/absolute) and `display` (formatted string).
 */
export function resolveAndFormat(
  targetPath?: string,
  root?: string,
): {
  path: WorkspacePathResolution;
  display: string;
} {
  const path = resolveWorkspaceRelativePath(targetPath, root);
  const display = toPosixPath(path.relative);
  return { path, display };
}

/**
 * Trim a string and throw a ToolError if the result is empty.
 * Centralizes the common pattern of validating non-empty input strings.
 */
export function requireNonEmptyString(
  value: string | null | undefined,
  fieldName = 'Value',
): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    throw new ToolError(`${fieldName} cannot be empty.`);
  }
  return trimmed;
}

/**
 * Validate that a field is not null/undefined for a given command.
 * Centralizes the common pattern of validating required parameters in tool execute methods.
 */
export function requireField<T>(
  value: T | null | undefined,
  fieldName: string,
  command: string,
): T {
  if (value == null) {
    throw new ToolError(
      `Parameter \`${fieldName}\` is required for command: ${command}`,
    );
  }
  return value;
}

/**
 * Wrap an async API call and convert any error to a ToolError.
 * Simplifies the common try-catch-rethrow-as-ToolError pattern.
 */
export async function wrapApiCall<T>(
  operation: () => Promise<T>,
  errorPrefix: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ToolError(`${errorPrefix}: ${toErrorMessage(error)}`);
  }
}

// ============================================================================
// Offset-based pagination for tool listings
// ============================================================================

/**
 * Slice an array by offset/limit and build display header + "next page" hint.
 *
 * All entries are loaded first then sliced client-side — this bounds the
 * text returned to the model, not the I/O cost of building the listing.
 */
export function paginateToolListing<T>(
  entries: readonly T[],
  offset: number,
  limit: number,
): { page: readonly T[]; start: number; end: number; total: number } {
  const total = entries.length;
  const safeOffset = total > 0 ? Math.min(offset, total - 1) : 0;
  const page = entries.slice(safeOffset, safeOffset + limit);
  return { page, start: safeOffset + 1, end: safeOffset + page.length, total };
}

/** Format a "N more — use offset: X" hint, or empty string if no more pages. */
export function formatPaginationHint(end: number, total: number): string {
  if (end >= total) return '';
  return `\n(${total - end} more \u2014 use offset: ${end} to see next page)`;
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
  /** Optional root directory override (e.g. a git worktree) */
  root?: string;
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
  root,
}: BuildFileAttachmentOptions): Promise<ToolFileAttachment> {
  if (!isNonEmptyString(filePath)) {
    throw new ToolError('Attachment path must be provided.');
  }

  const { path, display } = resolveAndFormat(filePath, root);
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

  // Strip binary data from oversized images to prevent non-retryable API 400 errors.
  // Downstream handlers see no bytes → metadata-only fallback with read_file hint.
  if (inferredMime.startsWith('image/') && isOversizedImage(buffer)) {
    buffer.fill(0);
    return {
      path: display,
      mimeType: inferredMime,
      description:
        (description ? `${description} — ` : '') +
        `Image exceeds ${MANY_IMAGE_MAX_DIMENSION}px dimension limit; binary data stripped`,
    };
  }

  const base64Data = includeBase64 ? buffer.toString('base64') : undefined;
  const bytes = Uint8Array.from(buffer);
  buffer.fill(0);

  return {
    path: display,
    mimeType: inferredMime,
    bytes,
    ...(description && { description }),
    ...(base64Data && { base64Data }),
  };
}
