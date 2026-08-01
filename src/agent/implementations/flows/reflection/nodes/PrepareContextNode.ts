import { Node } from '@agent/node';
import { ConversationRoundStateSnapshotSchema } from '@agent/core/state/AgentState';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { appendCompileFailureRoundContext } from '@agent/output/compileFailureRoundContext';

import type {
  ReflectionFlowShared,
  RoundContext,
} from '../ReflectionFlowState';
import type { ReflectionServices } from '../ReflectionServices';

interface PrepInput {
  currentRound: number;
  conversation: ProviderMessage[];
  compileFailureContext?: string;
}

export class PrepareContextNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<PrepInput> {
    return {
      currentRound: shared.currentRound,
      conversation: shared.conversation,
      compileFailureContext: shared.compileFailureContext,
    };
  }

  async exec(prepRes: PrepInput): Promise<RoundContext> {
    const { promptBuilder, logger } = this.services;
    const modelHandler = this.services.modelCell.handler;
    const { currentRound, conversation, compileFailureContext } = prepRes;

    const stateRound = ConversationRoundStateSnapshotSchema.parse({
      roundIndex: currentRound,
    });
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

    return {
      messages,
      stateRoundSnapshot: stateRound,
    };
  }

  async post(
    shared: ReflectionFlowShared,
    _prepRes: PrepInput,
    context: RoundContext,
  ): Promise<string | undefined> {
    shared.context = context;
    delete shared.compileFailureContext;
    return FlowTransition.DEFAULT;
  }
}
