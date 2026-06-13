// Local imports - core flow primitives
import { BaseNode } from '@agent/node';
import { logUserMessage } from '@agent/trace';
import {
  resetCycleState,
  saveCycleDebug,
} from '@agent/core/flows/CommonCycleTypes';
import { appendFollowUpAsUserMessage } from '@agent/toolUse/followUpMessages';
import type { FollowUpQueueBatchItem } from '@agent/toolUse/FollowUpQueue';

// Local file imports
import { FlowTransition } from '../FlowTransitions';
import type { CycleParams, ToolUseRoundServices } from '../CycleServices';
import type { ToolUseRoundShared } from './roundShared';

/** Prep result for ToolUsePrepNode - drained queued follow-up plus interrupt flag. */
interface ToolUsePrepResult {
  interrupted: boolean;
  queuedFollowUps: readonly FollowUpQueueBatchItem[] | null;
  synthetic: boolean;
}

/**
 * Prepares a tool-use cycle by checking interruptions and injecting queued follow-ups.
 *
 * If there are queued user messages (typed during previous tool execution),
 * they are injected here BEFORE calling the model. This ensures the model's
 * thinking/response considers the user's feedback.
 */
export class ToolUsePrepNode<C> extends BaseNode<
  ToolUseRoundShared,
  CycleParams,
  ToolUseRoundServices<C>
> {
  async prep(_shared: ToolUseRoundShared): Promise<ToolUsePrepResult> {
    const interrupted = this.services.checkInterruption();

    if (!this.services.session?.hasQueuedFollowUp()) {
      return {
        interrupted,
        queuedFollowUps: null,
        synthetic: false,
      };
    }

    // Drain without waiting (we know there's something queued)
    const batch = await this.services.session.waitForFollowUp(() => false);
    return {
      interrupted,
      queuedFollowUps: batch?.items ?? null,
      synthetic: batch?.synthetic ?? false,
    };
  }

  async post(
    shared: ToolUseRoundShared,
    prepRes: ToolUsePrepResult,
  ): Promise<string | undefined> {
    if (prepRes.interrupted) {
      shared.shouldStop = true;
      shared.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    // Inject queued follow-up BEFORE the model call
    // This ensures user's message typed during tool execution is seen
    // before the model starts thinking/responding
    if (prepRes.queuedFollowUps?.length) {
      if (!prepRes.synthetic) {
        for (const followUp of prepRes.queuedFollowUps) {
          logUserMessage(
            this.services.logger,
            followUp.displayText ?? followUp.text,
          );
        }
      }
      for (const followUp of prepRes.queuedFollowUps) {
        shared.messages = await appendFollowUpAsUserMessage(
          shared.messages,
          followUp,
          this.services,
        );
      }
      if (!prepRes.synthetic) {
        this.services.onFollowUpConsumed?.();
      }
    }

    resetCycleState(shared, [
      'response',
      'toolCalls',
      'text',
      'cycleNormalizedUsage',
    ]);
    shared.cycleResponseTimeMs = 0;

    await saveCycleDebug(shared.messages, 'messages', this.services, {
      continuationCount: shared.cycleIndex,
      baseName: 'tooluse',
    });

    return FlowTransition.DEFAULT;
  }
}
