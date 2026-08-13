import { logUserMessage, type AgentTrace } from '@agent/trace';
import type { IModelHandler } from '@agent/types/IModelHandler';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import {
  countMediaFilesNeedingVision,
  formatMediaNeedsVisionWarning,
  shouldWarnMediaNeedsVision,
} from '@agent/runtime/mediaVisionWarning';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import {
  deliveryTagOf,
  formatWorkflowScriptDeliverySummary,
  parseWorkflowScriptDeliverySummary,
  summarizeFollowupMessage,
} from '@shared/subagentFollowup';
import type {
  MediaAttachmentKind,
  WorkflowScriptDeliverySummary,
} from '@shared/schemas';
import type { TaskRunFileService } from '@utils/files/taskRunStorage';
import type { FollowUpQueueBatchItem } from './FollowUpQueue';

interface FollowUpMessageServices<C> {
  readonly modelCell: {
    readonly handler: Pick<
      IModelHandler<ProviderMessage, unknown, SdkToolCall, C>,
      'addMediaToUserMessage' | 'capabilities' | 'createUserFollowUpMessages'
    >;
  };
  readonly fileService: Pick<TaskRunFileService, 'createLocation'>;
  readonly logger: Pick<AgentTrace, 'warn'>;
}

interface FollowUpDisplay {
  readonly text: string;
  /** Typed workflow delivery facts logged beside the collapsed row text. */
  readonly workflowSummary?: WorkflowScriptDeliverySummary;
}

function followUpDisplay(followUp: FollowUpQueueBatchItem): FollowUpDisplay {
  if (followUp.displayText !== undefined) {
    return { text: followUp.displayText };
  }
  if (followUp.origin !== 'subagent_result') {
    return { text: followUp.text };
  }
  // This is where a delivery envelope becomes a transcript row: parse the
  // workflow summary once here and carry it structured, so renderers never
  // re-extract it from the rendered text. Only the workflow envelopes own a
  // `<workflow-summary>` element — other tags' bodies are entity-escaped.
  const tag = deliveryTagOf(followUp.text);
  const workflowSummary =
    tag === DELIVERY_TAG.workflowScriptResult ||
    tag === DELIVERY_TAG.workflowScriptError
      ? parseWorkflowScriptDeliverySummary(followUp.text)
      : undefined;
  if (workflowSummary) {
    return {
      text: formatWorkflowScriptDeliverySummary(workflowSummary),
      workflowSummary,
    };
  }
  return { text: summarizeFollowupMessage(followUp.text) };
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
  const nextMessages =
    await services.modelCell.handler.createUserFollowUpMessages(
      messages,
      followUp.text,
    );

  if (!followUp.mediaFiles?.length) {
    return { messages: nextMessages, attachmentKinds: [] };
  }

  if (
    shouldWarnMediaNeedsVision(
      followUp.mediaFiles,
      services.modelCell.handler.capabilities,
    )
  ) {
    const visionMediaCount = countMediaFilesNeedingVision(followUp.mediaFiles);
    services.logger.warn(
      formatMediaNeedsVisionWarning(visionMediaCount, 'pasted'),
    );
  }

  const attachmentKinds =
    await services.modelCell.handler.addMediaToUserMessage(
      nextMessages,
      followUp.mediaFiles.map((p) => services.fileService.createLocation(p)),
    );
  return { messages: nextMessages, attachmentKinds };
}

interface FollowUpBatchServices<C> extends Omit<
  FollowUpMessageServices<C>,
  'logger'
> {
  readonly logger: AgentTrace;
  /** Callback when a queued follow-up batch is consumed (clears UI display). */
  readonly onFollowUpConsumed?: () => void;
}

/**
 * Append one drained follow-up batch to `target.messages`.
 *
 * A non-synthetic follow-up's transcript row must be logged whether
 * appendFollowUpAsUserMessage succeeds or throws (e.g. a corrupt/oversized
 * media file) -- otherwise a failed round or resume leaves no record of what
 * the user asked for. `finally` preserves the throw so the caller still fails
 * as before; a throw before any attachment was inserted just yields an empty
 * attachments list, which is accurate (nothing was actually inserted).
 * Synthetic follow-ups are never logged, throw or not.
 *
 * Consumption is acknowledged only after every item actually landed in
 * `target.messages`: an append failure must leave the batch unacknowledged so
 * the resume wrapper restores it for replay instead of treating the lost input
 * as consumed.
 */
export async function applyFollowUpBatch<C>(
  target: { messages: ProviderMessage[] },
  followUps: readonly FollowUpQueueBatchItem[],
  synthetic: boolean | undefined,
  services: FollowUpBatchServices<C>,
): Promise<void> {
  for (const followUp of followUps) {
    let result: AppendFollowUpResult | undefined;
    try {
      result = await appendFollowUpAsUserMessage(
        target.messages,
        followUp,
        services,
      );
      target.messages = result.messages;
    } finally {
      if (!synthetic) {
        const display = followUpDisplay(followUp);
        logUserMessage(
          services.logger,
          display.text,
          result?.attachmentKinds ?? [],
          display.workflowSummary,
        );
      }
    }
  }

  if (!synthetic) {
    services.onFollowUpConsumed?.();
  }
}
