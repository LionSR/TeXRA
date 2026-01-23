import { z } from 'zod';

import {
  ToolError,
  ToolFileAttachmentSchema,
  type ToolFileAttachment,
} from '@tools/result';
import {
  buildFileAttachment,
  resolveAndFormat,
  type WorkspacePathResolution,
} from '@tools/utils';
import { WorkspaceFS } from '@utils/files';

// ============================================================================
// Figure Extraction Schemas
// ============================================================================

export const LatexFileResolutionSchema = z.object({
  path: z.custom<WorkspacePathResolution>(),
  display: z.string(),
});
export type LatexFileResolution = z.infer<typeof LatexFileResolutionSchema>;

export const AttachmentLimitResultSchema = z.object({
  attachments: z.array(ToolFileAttachmentSchema),
  limitedPaths: z.array(z.string()),
  limitReached: z.boolean(),
});
export type AttachmentLimitResult = z.infer<typeof AttachmentLimitResultSchema>;

export const AttachmentLimitOptionsSchema = z.object({
  limit: z.number(),
  describe: z.custom<(filePath: string) => string>(),
  mimeType: z.string().optional(),
});
export type AttachmentLimitOptions = z.infer<
  typeof AttachmentLimitOptionsSchema
>;

export async function resolveLatexFileOrThrow(
  texPath: string,
): Promise<LatexFileResolution> {
  const { path, display } = resolveAndFormat(texPath);
  if (!(await WorkspaceFS.exists(path.relative))) {
    throw new ToolError(`LaTeX file not found: ${display}`);
  }

  return { path, display };
}

export async function buildLimitedAttachments(
  paths: string[],
  { limit, describe, mimeType }: AttachmentLimitOptions,
): Promise<AttachmentLimitResult> {
  if (!Array.isArray(paths) || paths.length === 0 || limit <= 0) {
    return { attachments: [], limitedPaths: [], limitReached: false };
  }

  const limitCount = Math.min(paths.length, limit);
  const limitedPaths = paths.slice(0, limitCount);
  const attachments = await Promise.all(
    limitedPaths.map((filePath) =>
      buildFileAttachment({
        filePath,
        description: describe(filePath),
        mimeType,
      }),
    ),
  );

  return {
    attachments,
    limitedPaths,
    limitReached: paths.length > limitCount,
  };
}
