// Local imports - agent
import { ToolState } from '../../core/ToolState';
import type { ToolUseRunContext } from './types';
import type { ProviderMessage } from '../../modelHandlers/types/ProviderMessage';
import type { ToolUseCycleOptions } from '../../core/ToolUseCycle';
import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionManager';
import { ToolUseSessionManager } from '@agent/toolUse/ToolUseSessionManager';
import { getSystemPromptWithRules } from '../../utils/promptHelpers';
import { renderPrompt } from '../../utils/promptUtils';
import { TOOL_USE_INSTRUCTIONS } from '../../utils/toolUsePrompt';
import { BaseNode } from '../../node';

interface SetupPrompts {
  systemPrompt: string;
  userPrefix: string;
  userRequest: string;
}

interface SetupPrep<C> {
  snapshot: ToolUseSessionSnapshot | null;
  prompts?: SetupPrompts;
  modelHandler: ToolUseRunContext<C>['modelHandler'];
}

interface SetupExecResult {
  messages: ProviderMessage[];
  toolState: ToolState;
  resumed: boolean;
}

export class SetupToolUseSessionNode<C> extends BaseNode<
  ToolUseRunContext<C>,
  Record<string, never>,
  SetupPrep<C>,
  SetupExecResult
> {
  protected override async prep(
    context: ToolUseRunContext<C>,
  ): Promise<SetupPrep<C>> {
    const snapshot = context.consumeResumeSnapshot();
    if (snapshot) {
      return {
        snapshot,
        modelHandler: context.modelHandler,
      };
    }

    const systemPrompt = await getSystemPromptWithRules(
      `${context.agentPrompt.systemPrompt}\n${TOOL_USE_INSTRUCTIONS}`,
      context.userVars,
    );
    const userRequest = await renderPrompt(
      context.agentPrompt.userRequest,
      context.userVars,
    );
    const userPrefix = await renderPrompt(
      context.agentPrompt.userPrefix,
      context.userVars,
    );

    return {
      snapshot: null,
      prompts: { systemPrompt, userRequest, userPrefix },
      modelHandler: context.modelHandler,
    };
  }

  protected override async exec(
    prepResult: SetupPrep<C>,
  ): Promise<SetupExecResult> {
    if (prepResult.snapshot) {
      const rawMessages = prepResult.snapshot.messages ?? [];
      if (!Array.isArray(rawMessages)) {
        throw new Error('Invalid snapshot: messages must be an array');
      }
      return {
        messages: rawMessages as ProviderMessage[],
        toolState: ToolUseSessionManager.hydrateToolStateFromSnapshot(
          prepResult.snapshot,
        ),
        resumed: true,
      };
    }

    if (!prepResult.prompts) {
      throw new Error('Missing prompts for tool-use initialization');
    }

    const { userPrefix, userRequest, systemPrompt } = prepResult.prompts;
    const messages = await prepResult.modelHandler.initializeMessages(
      userPrefix,
      userRequest,
      undefined,
      systemPrompt,
    );

    return {
      messages,
      toolState: new ToolState(),
      resumed: false,
    };
  }

  protected override async post(
    context: ToolUseRunContext<C>,
    _prepResult: SetupPrep<C>,
    execResult: SetupExecResult,
  ): Promise<string> {
    context.setMessages(execResult.messages);
    context.setToolState(execResult.toolState);
    context.shouldSkipCycle = execResult.resumed;
    context.followUp = null;

    if (execResult.resumed) {
      context.logger.info('Resuming tool-use session from saved state.');
    }

    const toolState = context.getToolState();
    if (!toolState) {
      throw new Error('Tool state missing after setup.');
    }

    const cycleOptions: ToolUseCycleOptions<C> = {
      modelHandler: context.modelHandler,
      agentSetting: context.resolvedSetting,
      agentPrompt: context.agentPrompt,
      userVars: context.userVars,
      logger: context.logger,
      client: context.takeClient(),
      toolRegistry: context.toolRegistry,
      checkInterruption: () => context.checkInterruption(),
      setAbortController: context.setAbortController,
      toolState,
      modelName: context.agentConfig.model,
    };

    context.cycleOptions = cycleOptions;
    return 'continue';
  }
}
