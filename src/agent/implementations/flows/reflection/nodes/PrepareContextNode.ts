/**
 * PrepareContextNode - Prepares round context (prompts and messages).
 *
 * Builds prompts and initializes base messages via modelHandler.
 * TeXCount stats and media are added by subsequent nodes.
 */

import { Node } from '@agent/node';
import { ConversationRoundState } from '@agent/core/AgentState';
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

export class PrepareContextNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<ReflectionFlowShared> {
    return shared;
  }

  async exec(shared: ReflectionFlowShared): Promise<RoundContext> {
    const { promptBuilder, modelHandler, logger } = this.services;
    const { currentRound, conversation } = shared;

    const stateRound = new ConversationRoundState(currentRound);
    const isFirstRound = currentRound === 0;

    let messages: ProviderMessage[];
    if (isFirstRound) {
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();
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
      stateRoundSnapshot: stateRound.toSnapshot(),
    };
  }

  async post(
    shared: ReflectionFlowShared,
    _prepRes: ReflectionFlowShared,
    context: RoundContext,
  ): Promise<string | undefined> {
    shared.context = context;
    return FlowTransition.DEFAULT;
  }
}
