import { describe, expect, it } from 'vitest';

import { noopTrace, type AgentTrace } from '@agent/trace';
import { uploadToolAttachments } from '@agent/modelHandlers/anthropic/anthropicTools';
import type { ToolFileAttachment } from '@shared/schemas';

function createWarningRecorder(): {
  logger: AgentTrace;
  warnMessages: string[];
} {
  const warnMessages: string[] = [];
  const logger: AgentTrace = {
    ...noopTrace,
    warn: (message: string) => {
      warnMessages.push(message);
    },
  };
  return { logger, warnMessages };
}

/**
 * #7465: `uploadToolAttachments`'s per-attachment upload-failure catch now
 * funnels through the single `reportMediaAttachmentFailure` policy owner
 * instead of an ad hoc `logger.warn` call. Behavior is unchanged (degrade to
 * `unsupported`, continue with the rest, warn-level report — not escalated
 * to error, since a transient upload-service hiccup on one attachment is
 * common enough that it shouldn't render as a red error in the progress view;
 * see `CONTEXT_SEVERITY` in mediaAttachmentPolicy.ts) — this pins that down.
 */
describe('anthropicTools.uploadToolAttachments attachment failure policy (#7465)', () => {
  it('degrades a failed upload to unsupported, reports it, and still uploads the rest', async () => {
    const { logger, warnMessages } = createWarningRecorder();

    const attachments: ToolFileAttachment[] = [
      {
        path: 'broken.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      },
      {
        path: 'good.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([4, 5, 6]),
      },
    ];

    let callCount = 0;
    const client = {
      beta: {
        files: {
          upload: async () => {
            callCount += 1;
            if (callCount === 1) {
              throw new Error('upload service unavailable');
            }
            return { id: 'file_123' };
          },
        },
      },
    } as any;

    const result = await uploadToolAttachments(
      client,
      attachments,
      logger,
      0,
      () => {},
      100,
    );

    expect(result.uploaded.length, 'the second attachment should upload').toBe(
      1,
    );
    expect(result.uploaded[0].attachment.path).toBe('good.png');
    expect(
      result.unsupported.length,
      'the failed upload degrades to unsupported',
    ).toBe(1);
    expect(result.unsupported[0].path).toBe('broken.png');
    expect(
      warnMessages.some((m) => m.includes('broken.png')),
      'the failure should be reported through the shared policy owner',
    ).toBe(true);
  });

  it('uploads an unreadable PDF without a page count and warns about the skipped budget check', async () => {
    const { logger, warnMessages } = createWarningRecorder();

    const attachments: ToolFileAttachment[] = [
      {
        path: 'corrupt.pdf',
        mimeType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3]),
      },
    ];

    const client = {
      beta: {
        files: {
          upload: async () => ({ id: 'file_pdf' }),
        },
      },
    } as any;

    const pageCounts: Array<[string, number]> = [];
    const result = await uploadToolAttachments(
      client,
      attachments,
      logger,
      0,
      (fileId, pageCount) => pageCounts.push([fileId, pageCount]),
      100,
    );

    expect(
      result.uploaded.length,
      'an unparseable PDF still uploads so the API can enforce its own limit',
    ).toBe(1);
    expect(result.pageLimitExceeded.length).toBe(0);
    expect(
      pageCounts.length,
      'no page count is reported when the PDF cannot be parsed',
    ).toBe(0);
    expect(
      warnMessages.some((m) => m.includes('corrupt.pdf')),
      'the skipped local page-limit check must be logged, not silent',
    ).toBe(true);
  });
});
