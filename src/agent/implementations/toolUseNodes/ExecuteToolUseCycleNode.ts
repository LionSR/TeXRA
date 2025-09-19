// Local imports - agent
import { runToolUseCycle } from '../../core/ToolUseCycle';
import type { ProviderMessage } from '../../modelHandlers/types/ProviderMessage';
import { BaseNode, STOP_ACTION } from '../../node';
import type { ToolUseRunContext } from './types';

interface ExecutePrep<C> {
  cycleOptions: ToolUseRunContext<C>['cycleOptions'];
  messages: ProviderMessage[];
  shouldSkipCycle: boolean;
  interrupted: boolean;
}

type ExecuteStatus = 'stop' | 'skipped' | 'ran';

export class ExecuteToolUseCycleNode<C> extends BaseNode<
  ToolUseRunContext<C>,
  Record<string, never>,
  ExecutePrep<C>,
  ExecuteStatus
> {
  protected override async prep(
    context: ToolUseRunContext<C>,
  ): Promise<ExecutePrep<C>> {
    return {
      cycleOptions: context.cycleOptions,
      messages: context.getMessages(),
      shouldSkipCycle: context.shouldSkipCycle,
      interrupted: context.checkInterruption(),
    };
  }

  protected override async exec(
    prepResult: ExecutePrep<C>,
  ): Promise<ExecuteStatus> {
    if (prepResult.interrupted) {
      return 'stop';
    }

    if (prepResult.shouldSkipCycle) {
      return 'skipped';
    }

    if (!prepResult.cycleOptions) {
      throw new Error('Tool-use cycle options not initialized.');
    }

    await runToolUseCycle(prepResult.cycleOptions, prepResult.messages);
    return 'ran';
  }

  protected override async post(
    context: ToolUseRunContext<C>,
    _prepResult: ExecutePrep<C>,
    execResult: ExecuteStatus,
  ): Promise<string> {
    context.shouldSkipCycle = false;

    if (execResult === 'stop' || context.checkInterruption()) {
      return STOP_ACTION;
    }

    return 'continue';
  }
}
