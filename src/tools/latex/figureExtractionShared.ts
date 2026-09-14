import { Effect } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

import {
  ToolError,
  type ToolFileAttachment,
  type ToolResult,
} from '@shared/schemas';
import { buildFileAttachment } from '@tools/attachments';
import { formatToolOutput } from '@tools/formatting';
import {
  resolveAndFormat,
  type WorkspacePathResolution,
} from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import { ensureError } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';

/** Shared `texPath` Zod field for LaTeX extraction tools, with a per-tool description. */
export function texPathField(description: string): z.ZodString {
  return z.string().min(1, 'texPath is required.').describe(description);
}

interface LatexFileResolution {
  path: WorkspacePathResolution;
  display: string;
}

interface AttachmentLimitResult {
  attachments: ToolFileAttachment[];
  limitedPaths: string[];
  limitReached: boolean;
}

interface AttachmentLimitOptions {
  limit: number;
  describe: (filePath: string) => string;
  mimeType?: string;
}

/**
 * Shared "nothing found" result for extraction tools: an executed result
 * with no output body, formatted via `formatToolOutput(label, null)`.
 */
export function emptyExtractionResult(
  label: string,
  summary: string,
): Extract<ToolResult, { status: 'executed' }> {
  return executed(formatToolOutput(label, null), summary);
}

/** Attachment builds read files, so bound the fan-out. */
const ATTACHMENT_CONCURRENCY = 8;

export const resolveLatexFile = Effect.fn('tools.resolveLatexFile')(function* (
  texPath: string,
): Effect.fn.Return<LatexFileResolution, ToolError | Error, ToolCall> {
  const call = yield* ToolCall;
  const { path, display } = yield* Effect.try({
    try: () =>
      call.inScope(() => resolveAndFormat(texPath, call.workingDirectory)),
    catch: ensureError,
  });
  const exists = yield* Effect.tryPromise({
    try: () => AbsoluteFS.exists(path.absolute),
    catch: ensureError,
  });
  if (!exists) {
    return yield* Effect.fail(
      new ToolError(`LaTeX file not found: ${display}`),
    );
  }

  return { path, display };
});

export const buildLimitedAttachments = Effect.fn(
  'tools.buildLimitedAttachments',
)(function* (
  paths: readonly string[],
  { limit, describe, mimeType }: AttachmentLimitOptions,
): Effect.fn.Return<AttachmentLimitResult, ToolError, ToolCall> {
  if (paths.length === 0 || limit <= 0) {
    return { attachments: [], limitedPaths: [], limitReached: false };
  }

  const limitedPaths = paths.slice(0, limit);
  const attachments = yield* Effect.forEach(
    limitedPaths,
    (filePath) =>
      buildFileAttachment({
        filePath,
        description: describe(filePath),
        mimeType,
      }),
    { concurrency: ATTACHMENT_CONCURRENCY },
  );

  return {
    attachments,
    limitedPaths,
    limitReached: paths.length > limit,
  };
});
