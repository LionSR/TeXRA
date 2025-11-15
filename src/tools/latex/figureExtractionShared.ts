// Local imports - tools
import { ToolError, type ToolFileAttachment } from '@tools/result';
import {
  buildFileAttachment,
  resolveAndFormat,
  type WorkspacePathResolution,
} from '@tools/utils';
import { WorkspaceFS } from '@utils/files';

export interface LatexFileResolution {
  resolved: WorkspacePathResolution;
  display: string;
}

export interface AttachmentLimitResult {
  attachments: ToolFileAttachment[];
  limitedPaths: string[];
  limitReached: boolean;
}

export interface AttachmentLimitOptions {
  limit: number;
  describe: (filePath: string) => string;
  mimeType?: string;
}

export async function resolveLatexFileOrThrow(
  texPath: string,
): Promise<LatexFileResolution> {
  const { resolved, display } = resolveAndFormat(texPath);
  if (!(await WorkspaceFS.exists(resolved.relative))) {
    throw new ToolError(`LaTeX file not found: ${display}`);
  }

  return { resolved, display };
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
