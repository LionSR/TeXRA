// Standard library imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - agent
import type { AgentTrace } from '@agent/trace';
import { uploadToolAttachments } from '@agent/modelHandlers/anthropic/anthropicTools';
import { noopTrace } from '@agent/trace/noopTrace';
import type { ToolFileAttachment } from '@shared/schemas/toolResult';

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
      new Map(),
      100,
    );

    assert.equal(
      result.uploaded.length,
      1,
      'the second attachment should upload',
    );
    assert.equal(result.uploaded[0].attachment.path, 'good.png');
    assert.equal(
      result.unsupported.length,
      1,
      'the failed upload degrades to unsupported',
    );
    assert.equal(result.unsupported[0].path, 'broken.png');
    assert.ok(
      warnMessages.some((m) => m.includes('broken.png')),
      'the failure should be reported through the shared policy owner',
    );
  });
});
