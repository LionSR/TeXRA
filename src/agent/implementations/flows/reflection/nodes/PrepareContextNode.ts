/**
 * PrepareContextNode - Prepares round context (prompts and messages).
 *
 * Responsibilities:
 * - Build prompts via promptBuilder
 * - Initialize base messages via modelHandler (without texcount/media)
 *
 * Note: TeXCount stats and media are added by subsequent nodes
 * (TeXCountNode and MediaExtractionNode) using message enrichment methods.
 *
 * PocketFlow pattern:
 * - prep(): Extract data needed for context preparation
 * - exec(): Build prompts and base messages
 * - post(): Store context in shared
 *
 * Services accessed via native `this.services`:
 * - promptBuilder, modelHandler, logger
 */

import { Node } from '@agent/node';
import { ConversationRoundState } from '@agent/core/AgentState';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

import type {
  ReflectionFlowShared,
  RoundContext,
} from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

interface ContextPrepInput {
  currentRound: number;
  conversation: ProviderMessage[];
}

type ContextExecResult = { kind: 'ready'; context: RoundContext };

// ============================================================================
// Node Implementation
// ============================================================================

export class PrepareContextNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(shared: ReflectionFlowShared): Promise<ContextPrepInput> {
    return {
      currentRound: shared.currentRound,
      conversation: shared.conversation,
    };
  }

  async exec(prepRes: ContextPrepInput): Promise<ContextExecResult> {
    const { promptBuilder, modelHandler, logger } = this.services;
    const { currentRound, conversation } = prepRes;

    const stateRound = new ConversationRoundState(currentRound);
    const isFirstRound = currentRound === 0;

    // Build messages based on round
    const messages = isFirstRound
      ? await this.buildInitialMessages(promptBuilder, modelHandler)
      : await modelHandler.createRoundMessages(
          conversation,
          await promptBuilder.buildUserRequest(currentRound),
          undefined,
        );

    const prefill = await promptBuilder.buildPrefill(currentRound);

    logger.debug(
      `Prepared ${isFirstRound ? 'first' : `round ${currentRound}`} context with ${messages.length} messages`,
    );

    return {
      kind: 'ready',
      context: {
        messages,
        prefill: prefill ?? '',
        stateRoundSnapshot: stateRound.toSnapshot(),
      },
    };
  }

  private async buildInitialMessages(
    promptBuilder: ReflectionServices<C>['promptBuilder'],
    modelHandler: ReflectionServices<C>['modelHandler'],
  ): Promise<ProviderMessage[]> {
    const { systemPrompt, userRequest, userPrefix } =
      await promptBuilder.buildInitialPrompts();
    return modelHandler.initializeMessages(
      userPrefix,
      userRequest,
      undefined,
      systemPrompt,
    );
  }

  /**
   * Store context in shared and continue.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: ContextPrepInput,
    execRes: ContextExecResult,
  ): Promise<string | undefined> {
    // Store context for subsequent nodes to enrich
    shared.context = execRes.context;

    // Continue to TeXCountNode
    return FlowTransition.DEFAULT;
  }
}
