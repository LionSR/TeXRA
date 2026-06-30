import { ToolError, type ToolFileAttachment } from '@shared/schemas/toolResult';
import { buildFileAttachment } from '@tools/attachments';
import {
  resolveAndFormat,
  type WorkspacePathResolution,
} from '@tools/pathResolution';
import { WorkspaceFS } from '@utils/files';

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
  if (paths.length === 0 || limit <= 0) {
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
