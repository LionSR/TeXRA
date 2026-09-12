// Local imports - tools (single source of truth for file/attachment schemas)
import { type ToolFileAttachment } from '@shared/schemas';

// Local imports - utils
import { WorkspaceFS } from '@utils/files/workspaceFS';

export function wipeBuffer(buffer: Buffer | undefined): undefined {
  buffer?.fill(0);
  return undefined;
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
