import type { AgentTrace } from '@agent/trace';
import type {
  IModelHandler,
  SdkToolCall,
} from '@agent/modelHandlers/types/IModelHandler';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import {
  countMediaFilesNeedingVision,
  formatMediaNeedsVisionWarning,
  shouldWarnMediaNeedsVision,
} from '@agent/runtime/mediaVisionWarning';
import type { TaskRunFileService } from '@utils/files';
import type { FollowUpQueueBatchItem } from './FollowUpQueue';

interface FollowUpMessageServices<C> {
  readonly modelHandler: Pick<
    IModelHandler<ProviderMessage, unknown, unknown, SdkToolCall, C>,
    'addMediaToUserMessage' | 'capabilities' | 'createUserFollowUpMessages'
  >;
  readonly fileService: Pick<TaskRunFileService, 'createLocation'>;
  readonly logger: Pick<AgentTrace, 'warn'>;
}

export async function appendFollowUpAsUserMessage<C>(
  messages: ProviderMessage[],
  followUp: FollowUpQueueBatchItem,
  services: FollowUpMessageServices<C>,
): Promise<ProviderMessage[]> {
  const nextMessages = await services.modelHandler.createUserFollowUpMessages(
    messages,
    followUp.text,
  );

  if (!followUp.mediaFiles?.length) return nextMessages;

  const visionMediaCount = countMediaFilesNeedingVision(followUp.mediaFiles);
  if (
    shouldWarnMediaNeedsVision(
      followUp.mediaFiles,
      services.modelHandler.capabilities,
    )
  ) {
    services.logger.warn(
      formatMediaNeedsVisionWarning(visionMediaCount, 'pasted'),
    );
  }

  await services.modelHandler.addMediaToUserMessage(
    nextMessages,
    followUp.mediaFiles.map((p) => services.fileService.createLocation(p)),
  );
  return nextMessages;
}
