// Local imports - core flow primitives
import { BaseNode } from '@agent/node';
import { logUserMessage } from '@agent/trace';
import {
  resetCycleState,
  saveCycleDebug,
} from '@agent/core/flows/CommonCycleTypes';
import {
  appendFollowUpAsUserMessage,
  followUpDisplayText,
  type AppendFollowUpResult,
} from '@agent/followUp/followUpMessages';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';

// Local file imports
import { FlowTransition } from '../FlowTransitions';
import type { ToolUseRoundServices } from '../CycleServices';
import type { ToolUseRoundShared } from './roundShared';

/** Prep result for ToolUseRoundPrepNode - drained queued follow-up plus interrupt flag. */
interface ToolUseRoundPrepResult {
  interrupted: boolean;
  queuedFollowUps: readonly FollowUpQueueBatchItem[] | null;
  synthetic: boolean;
}

/**
 * Prepares one tool-use **round** (a single LLM invocation) by checking for
 * interruptions and injecting any queued user follow-ups BEFORE the model call.
 *
 * "Round" = one invocation of the model inside `ToolUseRoundFlow`. This is the
 * inner-loop prep node. Compare `ToolUsePrepareNode` in
 * `implementations/flows/tooluse/nodes/`, which is the outer session-init node
 * that runs once per tool-use session (builds initial messages, loads snapshots).
 *
 * If there are queued user messages (typed during previous tool execution),
 * they are injected here BEFORE calling the model. This ensures the model's
 * thinking/response considers the user's feedback.
 */
export class ToolUseRoundPrepNode<C> extends BaseNode<
  ToolUseRoundShared,
  ToolUseRoundServices<C>
> {
  async prep(_shared: ToolUseRoundShared): Promise<ToolUseRoundPrepResult> {
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
    prepRes: ToolUseRoundPrepResult,
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
      for (const followUp of prepRes.queuedFollowUps) {
        // A non-synthetic follow-up's transcript row must be logged whether
        // appendFollowUpAsUserMessage succeeds or throws (e.g. a corrupt/
        // oversized media file) -- otherwise a failed follow-up round leaves
        // no record of what the user asked for. `finally` preserves the
        // throw so the round still fails as before; a throw before any
        // attachment was inserted just yields an empty attachments list,
        // which is accurate (nothing was actually inserted). Synthetic
        // follow-ups are still never logged, throw or not -- unchanged from
        // before this fix.
        let result: AppendFollowUpResult | undefined;
        try {
          result = await appendFollowUpAsUserMessage(
            shared.messages,
            followUp,
            this.services,
          );
          shared.messages = result.messages;
        } finally {
          if (!prepRes.synthetic) {
            logUserMessage(
              this.services.logger,
              followUpDisplayText(followUp),
              result?.attachmentKinds ?? [],
            );
          }
        }
      }
      if (!prepRes.synthetic) {
        this.services.onFollowUpConsumed?.();
      }
    }

    resetCycleState(shared, [
      'response',
      'toolCalls',
      'text',
      'roundNormalizedUsage',
    ]);
    shared.roundResponseTimeMs = 0;

    await saveCycleDebug(shared.messages, 'messages', this.services, {
      continuationCount: shared.roundIndex,
      baseName: 'tooluse',
    });

    return FlowTransition.DEFAULT;
  }
}
