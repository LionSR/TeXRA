// Node imports
import { basename } from 'node:path';

// Local imports
import type { AgentTrace } from '@agent/trace';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { AnthropicToolCall } from '@agent/types/ModelHandlerContracts';
import type { ToolFileAttachment, ToolResult } from '@shared/schemas';

// Local file imports
import { AUXILIARY_MAX_RETRIES } from '../support/auxiliaryRetry';
import {
  describeAttachments,
  formatAttachmentSummaryFromNotes,
  formatToolResultAsText,
  uploadAndRecordToolAttachments,
} from '../utils/toolAttachmentUtils';
import {
  uploadToolAttachments,
  type UploadedAnthropicAttachment,
} from './anthropicTools';

// Third-party imports
import type { Anthropic } from '@anthropic-ai/sdk';
import type {
  Base64ImageSource,
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

/** One executed tool call plus the attachments its result produced. */
export interface AnthropicToolResultEntry {
  call: AnthropicToolCall;
  result: ToolResult;
  attachments: ToolFileAttachment[];
}

/**
 * Handler state the tool-result builders read: capability flags, the logger,
 * the PDF-page tracking counters shared with request-time token estimation,
 * and the assistant-side content builder that consumes the stored response
 * content exactly once per follow-up turn.
 */
export interface AnthropicToolResultContext {
  logger: AgentTrace;
  supportsToolResultFileUpload: boolean;
  canProcessToolResultAttachments: boolean;
  getTrackedPdfPageCount(): number;
  recordPdfPageCount(fileId: string, pageCount: number): void;
  getMaxPdfPages(): number;
  buildToolCallAssistantContent(
    workspaceState: AgentWorkspaceState | undefined,
    text: string | undefined,
  ): ContentBlockParam[];
}

/**
 * Build one tool_result block, uploading attachments when supported.
 */
async function buildToolResultBlock(
  ctx: AnthropicToolResultContext,
  client: Anthropic,
  call: AnthropicToolCall,
  result: ToolResult,
  attachments: ToolFileAttachment[],
): Promise<ContentBlockParam> {
  // Result is already sanitized by source - use the passed attachments
  const canUpload = ctx.supportsToolResultFileUpload && attachments.length > 0;

  // This upload occurs while assembling the next turn, outside the model
  // invocation gate. Restore the SDK's ordinary two retries for this
  // auxiliary request; generation requests keep maxRetries: 0.
  const { finalResult: sanitizedResult, uploadResult } =
    await uploadAndRecordToolAttachments(result, canUpload, () =>
      uploadToolAttachments(
        client.withOptions({ maxRetries: AUXILIARY_MAX_RETRIES }),
        attachments,
        ctx.logger,
        ctx.getTrackedPdfPageCount(),
        ctx.recordPdfPageCount,
        ctx.getMaxPdfPages(),
      ),
    );

  const uploadedAttachments: UploadedAnthropicAttachment[] =
    uploadResult?.uploaded ?? [];
  const unsupportedAttachments: ToolFileAttachment[] = canUpload
    ? [...(uploadResult?.unsupported ?? [])]
    : [...attachments];
  const pageLimitExceeded: ToolFileAttachment[] =
    uploadResult?.pageLimitExceeded ?? [];

  // Build tool result as plain text - JSON wastes tokens
  // Note: Anthropic handles attachments as separate content blocks, not in text
  const toolResultContent: Array<
    TextBlockParam | ImageBlockParam | DocumentBlockParam
  > = [{ type: 'text', text: formatToolResultAsText(result) }];

  const unsupportedNotes: string[] = [];

  for (const uploaded of uploadedAttachments) {
    const attachmentNote = `${uploaded.attachment.path ?? 'attachment'} (${uploaded.attachment.mimeType})`;

    switch (uploaded.blockType) {
      case 'image':
        if (ctx.canProcessToolResultAttachments && uploaded.base64Data) {
          toolResultContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type:
                (uploaded.mediaType as Base64ImageSource['media_type']) ??
                'image/png',
              data: uploaded.base64Data,
            },
          } as ImageBlockParam);
        } else {
          unsupportedNotes.push(attachmentNote);
        }
        break;

      case 'document':
        if (uploaded.base64Data) {
          toolResultContent.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type:
                (uploaded.mediaType as 'application/pdf') ?? 'application/pdf',
              data: uploaded.base64Data,
            },
            title: basename(uploaded.attachment.path ?? 'attachment.pdf'),
          } as DocumentBlockParam);
        } else {
          unsupportedNotes.push(attachmentNote);
        }
        break;

      default:
        unsupportedNotes.push(attachmentNote);
    }
  }

  if (unsupportedAttachments.length > 0) {
    unsupportedNotes.push(...describeAttachments(unsupportedAttachments));
  }

  if (pageLimitExceeded.length > 0) {
    const remaining = ctx.getMaxPdfPages() - ctx.getTrackedPdfPageCount();
    const names = pageLimitExceeded
      .map((a) => a.path ?? 'attachment.pdf')
      .join(', ');
    toolResultContent.unshift({
      type: 'text',
      text: `PDF page limit reached. Could not include: ${names}. ${remaining} of ${ctx.getMaxPdfPages()} PDF pages remaining in this conversation. Tell the user.`,
    });
  }

  if (unsupportedNotes.length > 0) {
    const notesText = unsupportedNotes.join('\n');
    toolResultContent.unshift({
      type: 'text',
      text: formatAttachmentSummaryFromNotes(notesText, 'metadata-fallback'),
    });
    if (!sanitizedResult.attachmentSummary) {
      // Store summary without the instruction (it's in the text block above)
      sanitizedResult.attachmentSummary = `Attachments available but returned as metadata only:\n${notesText}`;
    }
  }

  return {
    type: 'tool_result',
    tool_use_id: call.callId,
    content: toolResultContent,
    is_error: result.status === 'error' || undefined,
  };
}

/**
 * Batched variant for parallel tool calls: one assistant message carrying
 * the original response content plus ALL tool_use blocks, then ONE user
 * message with all tool_result blocks. This is the wire shape Anthropic
 * documents for parallel tool use — splitting results into alternating
 * per-call message pairs reads as sequential history and trains the model
 * away from parallel calls (and would replay thinking blocks incorrectly).
 */
export async function createBatchedToolUseFollowUpMessages(
  ctx: AnthropicToolResultContext,
  entries: AnthropicToolResultEntry[],
  workspaceState: AgentWorkspaceState | undefined,
  text: string | undefined,
  client: Anthropic,
): Promise<MessageParam[]> {
  if (entries.length === 0) return [];

  const content = ctx.buildToolCallAssistantContent(workspaceState, text);
  for (const { call } of entries) {
    content.push({
      type: 'tool_use',
      id: call.callId,
      name: call.name,
      input: call.raw.input ?? {},
    });
  }

  // Sequential on purpose: uploads share the PDF-page tracking state.
  const resultBlocks: ContentBlockParam[] = [];
  for (const { call, result, attachments } of entries) {
    resultBlocks.push(
      await buildToolResultBlock(ctx, client, call, result, attachments),
    );
  }

  return [
    { role: 'assistant', content },
    { role: 'user', content: resultBlocks },
  ];
}
