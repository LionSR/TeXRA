// Local imports - agent
import type { ToolUseRunContext } from './types';
import { BaseNode, STOP_ACTION } from '../../node';

interface AwaitPrep<C> {
  hasQueuedFollowUp: boolean;
  waitForFollowUp: ToolUseRunContext<C>['waitForFollowUp'];
  enterWaitingState: ToolUseRunContext<C>['enterWaitingState'];
  clearPersistedSnapshot: ToolUseRunContext<C>['clearPersistedSnapshot'];
}

interface AwaitExecResult {
  followUp: string | null;
}

export class AwaitFollowUpNode<C> extends BaseNode<
  ToolUseRunContext<C>,
  Record<string, never>,
  AwaitPrep<C>,
  AwaitExecResult
> {
  protected override async prep(
    context: ToolUseRunContext<C>,
  ): Promise<AwaitPrep<C>> {
    return {
      hasQueuedFollowUp: context.hasQueuedFollowUp(),
      waitForFollowUp: context.waitForFollowUp,
      enterWaitingState: context.enterWaitingState,
      clearPersistedSnapshot: context.clearPersistedSnapshot,
    };
  }

  protected override async exec(
    prepResult: AwaitPrep<C>,
  ): Promise<AwaitExecResult> {
    if (prepResult.hasQueuedFollowUp) {
      await prepResult.clearPersistedSnapshot();
    } else {
      await prepResult.enterWaitingState();
    }

    const followUp = await prepResult.waitForFollowUp();
    return { followUp };
  }

  protected override async post(
    context: ToolUseRunContext<C>,
    _prepResult: AwaitPrep<C>,
    execResult: AwaitExecResult,
  ): Promise<string> {
    const { followUp } = execResult;
    context.followUp = followUp;

    if (!followUp || context.checkInterruption()) {
      return STOP_ACTION;
    }

    await context.markRunning();
    await context.clearPersistedSnapshot();

    context.logger.userMessage(followUp);
    const updatedMessages =
      await context.modelHandler.createUserFollowUpMessages(
        context.getMessages(),
        followUp,
      );
    context.setMessages(updatedMessages);

    return 'continue';
  }
}
