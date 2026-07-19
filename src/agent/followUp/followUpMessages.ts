import type { AgentTrace } from '@agent/trace';
import type { IModelHandler } from '@agent/types/IModelHandler';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import {
  countMediaFilesNeedingVision,
  formatMediaNeedsVisionWarning,
  shouldWarnMediaNeedsVision,
} from '@agent/runtime/mediaVisionWarning';
import { summarizeFollowupMessage } from '@shared/subagentFollowup';
import type { MediaAttachmentKind } from '@shared/schemas';
import type { TaskRunFileService } from '@utils/files';
import type { FollowUpQueueBatchItem } from './FollowUpQueue';

interface FollowUpMessageServices<C> {
  readonly modelHandler: Pick<
    IModelHandler<ProviderMessage, unknown, SdkToolCall, C>,
    'addMediaToUserMessage' | 'capabilities' | 'createUserFollowUpMessages'
  >;
  readonly fileService: Pick<TaskRunFileService, 'createLocation'>;
  readonly logger: Pick<AgentTrace, 'warn'>;
}

export function followUpDisplayText(followUp: FollowUpQueueBatchItem): string {
  if (followUp.displayText !== undefined) return followUp.displayText;
  return followUp.origin === 'subagent_result'
    ? summarizeFollowupMessage(followUp.text)
    : followUp.text;
}

export function userFollowUpInstruction(
  followUps: readonly FollowUpQueueBatchItem[],
): string | undefined {
  const instruction = followUps
    .filter((followUp) => followUp.origin === 'user')
    .map((followUp) => followUp.text)
    .join('\n\n')
    .trim();
  return instruction || undefined;
}

export interface AppendFollowUpResult {
  readonly messages: ProviderMessage[];
  readonly attachmentKinds: MediaAttachmentKind[];
}

export async function appendFollowUpAsUserMessage<C>(
  messages: ProviderMessage[],
  followUp: FollowUpQueueBatchItem,
  services: FollowUpMessageServices<C>,
): Promise<AppendFollowUpResult> {
  const nextMessages = await services.modelHandler.createUserFollowUpMessages(
    messages,
    followUp.text,
  );

  if (!followUp.mediaFiles?.length) {
    return { messages: nextMessages, attachmentKinds: [] };
  }

  if (
    shouldWarnMediaNeedsVision(
      followUp.mediaFiles,
      services.modelHandler.capabilities,
    )
  ) {
    const visionMediaCount = countMediaFilesNeedingVision(followUp.mediaFiles);
    services.logger.warn(
      formatMediaNeedsVisionWarning(visionMediaCount, 'pasted'),
    );
  }

  const attachmentKinds = await services.modelHandler.addMediaToUserMessage(
    nextMessages,
    followUp.mediaFiles.map((p) => services.fileService.createLocation(p)),
  );
  return { messages: nextMessages, attachmentKinds };
}
