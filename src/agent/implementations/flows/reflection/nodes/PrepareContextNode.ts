import { Node } from '@agent/node';
import { createRoundState } from '@agent/core/AgentState';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

import type {
  ReflectionFlowShared,
  RoundContext,
} from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

interface PrepInput {
  currentRound: number;
  conversation: ProviderMessage[];
}

export class PrepareContextNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<PrepInput> {
    return {
      currentRound: shared.currentRound,
      conversation: shared.conversation,
    };
  }

  async exec(prepRes: PrepInput): Promise<RoundContext> {
    const { promptBuilder, modelHandler, logger } = this.services;
    const { currentRound, conversation } = prepRes;

    const stateRound = createRoundState(currentRound);
    const isFirstRound = currentRound === 0;

    let messages: ProviderMessage[];
    if (isFirstRound) {
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();

      // Log the initial instruction as a userMessage so it appears in the
      // progress view logs — consistent with tool-use agents (ToolUsePrepareNode).
      if (userRequest) {
        logger.userMessage(userRequest);
      }

      messages = await modelHandler.initializeMessages(
        userPrefix,
        userRequest,
        undefined,
        systemPrompt,
      );
    } else {
      messages = await modelHandler.createRoundMessages(
        conversation,
        await promptBuilder.buildUserRequest(currentRound),
        undefined,
      );
    }

    const prefill = await promptBuilder.buildPrefill(currentRound);

    logger.debug(
      `Prepared ${isFirstRound ? 'first' : `round ${currentRound}`} context with ${messages.length} messages`,
    );

    return {
      messages,
      prefill: prefill ?? '',
      stateRoundSnapshot: stateRound,
    };
  }

  async post(
    shared: ReflectionFlowShared,
    _prepRes: PrepInput,
    context: RoundContext,
  ): Promise<string | undefined> {
    shared.context = context;
    return FlowTransition.DEFAULT;
  }
}
