import { Effect, FileSystem, Schema } from 'effect';
import { type ToolResult } from '@texra-ai/harness';
import { ToolContext } from '@texra-ai/harness/plugins';
import { entryTypeIn } from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';
import {
  resolveToolPath,
  type WorkspacePathResolution,
  executed,
  ToolError,
  type ToolFileAttachment,
  buildFileAttachment,
  formatToolOutput,
} from '@texra-ai/harness/plugins';

/** Shared `texPath` field for LaTeX extraction tools, with a per-tool description. */
export function texPathField(description: string): Schema.String {
  return Schema.String.check(Schema.isMinLength(1)).annotate({ description });
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
): Effect.fn.Return<
  LatexFileResolution,
  ToolError | Error,
  ToolContext | FileSystem.FileSystem
> {
  const call = yield* ToolContext;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* resolveToolPath(call.env, texPath).pipe(
    Effect.mapError(ensureError),
  );
  const { display } = path;
  const exists = (yield* entryTypeIn(fs, path.absolute)) !== undefined;
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
): Effect.fn.Return<
  AttachmentLimitResult,
  ToolError,
  ToolContext | FileSystem.FileSystem
> {
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
