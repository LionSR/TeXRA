// Local imports - core flow primitives
import { BaseNode } from '@agent/node';
import {
  resetCycleState,
  saveCycleDebug,
} from '@agent/core/flows/CommonCycleTypes';
import {
  applyFollowUpBatch,
  userFollowUpInstruction,
} from '@agent/followUp/followUpMessages';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';

// Local file imports
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
    const interrupted = this.services.runScope.signal.aborted;

    if (!this.services.session?.hasQueuedFollowUp()) {
      return {
        interrupted,
        queuedFollowUps: null,
        synthetic: false,
      };
    }

    // Drain without waiting (we know there's something queued)
    const batch = await this.services.session.waitForFollowUp(
      this.services.runScope.signal,
    );
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
      if (!prepRes.synthetic) {
        const instruction = userFollowUpInstruction(prepRes.queuedFollowUps);
        if (instruction) shared.currentUserInstruction = instruction;
      }
      await applyFollowUpBatch(
        shared,
        prepRes.queuedFollowUps,
        prepRes.synthetic,
        this.services,
      );
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
