// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { StreamTabId } from '@shared/schemas';
import type {
  ProgressViewInboundHandlerRegistry,
  ProgressViewInboundMessage,
} from '@shared/schemas/progressView';

// Local imports - utilities
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';

type SendFollowUpMessage = Extract<
  ProgressViewInboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP }
>;

export type ProgressViewFollowUpImage = NonNullable<
  SendFollowUpMessage['images']
>[number];

export interface ProgressViewFollowUpSubmission {
  stream: StreamTabId;
  text: string;
  mediaFiles?: readonly string[];
}

export interface ProgressViewFollowUpCommandActions {
  sendFollowUp(
    submission: ProgressViewFollowUpSubmission,
  ): Promise<void> | void;
  reportImageSaveError(image: ProgressViewFollowUpImage, error: unknown): void;
}

export function createProgressViewFollowUpCommandHandlers(
  actions: ProgressViewFollowUpCommandActions,
): ProgressViewInboundHandlerRegistry {
  return {
    [PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]: async (data) => {
      const mediaFiles = await saveFollowUpImages(
        data.images ?? [],
        actions.reportImageSaveError,
      );
      await actions.sendFollowUp({
        stream: data.stream,
        text: data.text,
        ...(mediaFiles.length > 0 ? { mediaFiles } : {}),
      });
    },
  };
}

async function saveFollowUpImages(
  images: readonly ProgressViewFollowUpImage[],
  reportImageSaveError: ProgressViewFollowUpCommandActions['reportImageSaveError'],
): Promise<string[]> {
  const mediaFiles: string[] = [];
  for (const image of images) {
    try {
      mediaFiles.push(
        await savePastedImageBase64(image.base64, image.fileName),
      );
    } catch (error) {
      reportImageSaveError(image, error);
    }
  }
  return mediaFiles;
}
