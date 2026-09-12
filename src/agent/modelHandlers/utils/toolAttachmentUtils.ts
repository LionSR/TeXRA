// Local imports - tools (single source of truth for file/attachment schemas)
import { type ToolFileAttachment, type ToolResult } from '@shared/schemas';

// Local imports - utils
import { WorkspaceFS } from '@utils/files/workspaceFS';

export function wipeBuffer(buffer: Buffer | undefined): undefined {
  buffer?.fill(0);
  return undefined;
}

/** A single uploaded attachment, in the shape common to every provider's
 * upload result: the source attachment plus the id it was uploaded under. */
interface UploadedAttachmentBase {
  attachment: ToolFileAttachment;
  fileId: string;
}

/**
 * Runs a provider's upload call, then folds the uploaded set into a
 * `finalResult.files` copy of `result` — the block every handler's
 * tool-result follow-up path (Anthropic's `buildToolResultBlock`, OpenAI
 * Responses' `createBatchedToolUseFollowUpMessages`) repeated identically. Each
 * provider's actual upload call has its own signature and return shape
 * (Anthropic's also reports `unsupported`/`pageLimitExceeded`; OpenAI's does
 * not), so `upload` is the caller's own closure and its full return value is
 * handed back untouched for the caller to destructure further.
 */
export async function uploadAndRecordToolAttachments<
  TUploadResult extends { uploaded: UploadedAttachmentBase[] },
>(
  result: ToolResult,
  canUpload: boolean,
  upload: () => Promise<TUploadResult>,
): Promise<{
  finalResult: ToolResult;
  uploadResult: TUploadResult | undefined;
}> {
  const finalResult: ToolResult = { ...result };

  if (!canUpload) {
    return { finalResult, uploadResult: undefined };
  }

  const uploadResult = await upload();

  if (result.status === 'executed' && uploadResult.uploaded.length > 0) {
    finalResult.files = uploadResult.uploaded.map(({ attachment, fileId }) => ({
      path: attachment.path,
      mimeType: attachment.mimeType,
      description: attachment.description,
      fileId,
    })) as typeof finalResult.files;
  }

  return { finalResult, uploadResult };
}

export async function loadAttachmentBuffer(
  attachment: ToolFileAttachment,
): Promise<Buffer> {
  if (attachment.bytes?.length) {
    return Buffer.from(attachment.bytes);
  }
  if (attachment.base64Data?.length) {
    return Buffer.from(attachment.base64Data, 'base64');
  }
  if (attachment.path?.length) {
    return WorkspaceFS.readBytes(attachment.path);
  }
  throw new Error('Attachment did not include bytes, base64 data, or a path.');
}
