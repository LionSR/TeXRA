import { BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { appendCompileFailureRoundContext } from '../output/compileFailureRoundContext';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type { ReflectionServices } from '../ReflectionServices';

interface PrepInput {
  currentRound: number;
  conversation: ProviderMessage[];
  compileFailureContext?: string;
}

export class PrepareContextNode extends BaseNode<
  ReflectionFlowShared,
  ReflectionServices
> {
  override async prep(shared: ReflectionFlowShared): Promise<PrepInput> {
    return {
      currentRound: shared.currentRound,
      conversation: shared.context ?? [],
      compileFailureContext: shared.compileFailureContext,
    };
  }

  override async exec(prepRes: PrepInput): Promise<ProviderMessage[]> {
    const { promptBuilder, logger } = this.services;
    const modelHandler = this.services.modelCell.handler;
    const { currentRound, conversation, compileFailureContext } = prepRes;

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
      const userRequest = appendCompileFailureRoundContext(
        await promptBuilder.buildUserRequest(currentRound),
        compileFailureContext,
      );
      messages = await modelHandler.createRoundMessages(
        conversation,
        userRequest,
        undefined,
      );
    }

    logger.debug('Prepared round context', {
      data: {
        round: isFirstRound ? 'first' : currentRound,
        messageCount: messages.length,
      },
    });

    return messages;
  }

  override async post(
    shared: ReflectionFlowShared,
    _prepRes: PrepInput,
    context: ProviderMessage[],
  ): Promise<string | undefined> {
    shared.context = context;
    delete shared.compileFailureContext;
    return FlowTransition.DEFAULT;
  }
}
