// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { createProgressViewFollowUpCommandHandlers } from '@controllers/progressView/ProgressViewFollowUpCommandHandlers';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  ProgressViewInboundMessageSchema,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';

vi.mock('@utils/files/pastedImageUtils', () => ({
  savePastedImageBase64: vi.fn(),
}));

const savePastedImageBase64Mock = vi.mocked(savePastedImageBase64);

type SendFollowUpMessage = Extract<
  ProgressViewInboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP }
>;

function parseSendFollowUpMessage(message: unknown): SendFollowUpMessage {
  const parsed = ProgressViewInboundMessageSchema.parse(message);
  if (parsed.command !== PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP) {
    throw new Error(`Expected SEND_FOLLOW_UP, got ${parsed.command}`);
  }
  return parsed;
}

describe('createProgressViewFollowUpCommandHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes text-only follow-ups to the host action', async () => {
    const actions = {
      sendFollowUp: vi.fn(),
      reportImageSaveError: vi.fn(),
    };
    const handlers = createProgressViewFollowUpCommandHandlers(actions);

    await handlers[PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]?.(
      parseSendFollowUpMessage({
        command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
        stream: 'stream-a',
        text: 'continue',
      }),
    );

    expect(savePastedImageBase64Mock).not.toHaveBeenCalled();
    expect(actions.reportImageSaveError).not.toHaveBeenCalled();
    expect(actions.sendFollowUp).toHaveBeenCalledWith({
      stream: 'stream-a',
      text: 'continue',
    });
  });

  it('persists follow-up images and keeps sending text after an image save fails', async () => {
    const failedImageError = new Error('bad image');
    savePastedImageBase64Mock
      .mockResolvedValueOnce('/tmp/pasted/a.png')
      .mockRejectedValueOnce(failedImageError);

    const actions = {
      sendFollowUp: vi.fn(),
      reportImageSaveError: vi.fn(),
    };
    const handlers = createProgressViewFollowUpCommandHandlers(actions);
    const failedImage = {
      base64: 'broken',
      mediaType: 'image/png',
      fileName: 'pasted_2.png',
    };

    await handlers[PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]?.(
      parseSendFollowUpMessage({
        command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
        stream: 'stream-a',
        text: 'look at these',
        images: [
          {
            base64: 'ok',
            mediaType: 'image/png',
            fileName: 'pasted_1.png',
          },
          failedImage,
        ],
      }),
    );

    expect(savePastedImageBase64Mock).toHaveBeenNthCalledWith(
      1,
      'ok',
      'pasted_1.png',
    );
    expect(savePastedImageBase64Mock).toHaveBeenNthCalledWith(
      2,
      'broken',
      'pasted_2.png',
    );
    expect(actions.reportImageSaveError).toHaveBeenCalledWith(
      failedImage,
      failedImageError,
    );
    expect(actions.sendFollowUp).toHaveBeenCalledWith({
      stream: 'stream-a',
      text: 'look at these',
      mediaFiles: ['/tmp/pasted/a.png'],
    });
  });
});
