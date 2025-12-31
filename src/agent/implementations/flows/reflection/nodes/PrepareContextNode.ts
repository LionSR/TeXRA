/**
 * PrepareContextNode - Prepares round context (prompts and messages).
 *
 * Responsibilities:
 * - Build prompts via promptBuilder
 * - Initialize base messages via modelHandler (without texcount/media)
 *
 * Note: TeXCount stats and media are added by subsequent nodes
 * (TeXCountNode and MediaPreparationNode) using message enrichment methods.
 *
 * PocketFlow pattern:
 * - prep(): Extract data needed for context preparation
 * - exec(): Build prompts and base messages
 * - post(): Store context in shared, handle skip
 *
 * Services accessed via native `this.services`:
 * - promptBuilder, modelHandler, logger
 *
 * State access pattern:
 * - Uses direct state fields (currentRound, conversation, totalRounds, context)
 * - No snapshot helpers needed (doesn't access workspaceState, runState, or roundStates)
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

type ContextExecResult =
  | { kind: 'ready'; context: RoundContext }
  | { kind: 'skip' };

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

  /**
   * Extract data needed for context preparation.
   */
  async prep(shared: ReflectionFlowShared): Promise<ContextPrepInput> {
    return {
      currentRound: shared.state.currentRound,
      conversation: shared.state.conversation,
    };
  }

  /**
   * Build prompts and base messages for the round.
   * Does NOT include texcount stats or media - those are added by subsequent nodes.
   */
  async exec(prepRes: ContextPrepInput): Promise<ContextExecResult> {
    const { promptBuilder, modelHandler, logger } = this.services;
    const { currentRound, conversation } = prepRes;

    const stateRound = new ConversationRoundState(currentRound);

    if (currentRound === 0) {
      // First round: build initial prompts
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();

      // Build prefill
      const prefill = await promptBuilder.buildPrefill(currentRound);

      // Initialize base messages (no media - will be added by MediaPreparationNode)
      const messages = await modelHandler.initializeMessages(
        userPrefix,
        userRequest,
        undefined, // media added later by MediaPreparationNode
        systemPrompt,
      );

      logger.debug(
        `Prepared first round base context with ${messages.length} messages`,
      );

      return {
        kind: 'ready',
        context: {
          messages,
          prefill: prefill ?? '',
          stateRoundSnapshot: stateRound.toSnapshot(),
        },
      };
    } else {
      // Subsequent rounds: build user request only
      const userRequest = await promptBuilder.buildUserRequest(currentRound);

      // Check for skip (no content)
      if (!userRequest?.trim()) {
        logger.debug(`Skipping round ${currentRound} - no user content`);
        return { kind: 'skip' };
      }

      // Build prefill
      const prefill = await promptBuilder.buildPrefill(currentRound);

      // Create round messages (no media - will be added by MediaPreparationNode)
      const messages = await modelHandler.createRoundMessages(
        conversation,
        userRequest,
        undefined, // media added later by MediaPreparationNode
      );

      logger.debug(
        `Prepared round ${currentRound} base context with ${messages.length} messages`,
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
  }

  /**
   * Store context in shared or handle skip.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: ContextPrepInput,
    execRes: ContextExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'skip') {
      // Increment round and loop back to start of flow
      shared.state.currentRound += 1;

      // Bounds check to prevent infinite loop when all remaining rounds are empty
      if (shared.state.currentRound >= shared.state.totalRounds) {
        return FlowTransition.DEFAULT; // Exit flow - no more rounds
      }

      return FlowTransition.CONTINUE;
    }

    // Store context for subsequent nodes to enrich
    shared.state.context = execRes.context;

    // Continue to TeXCountNode
    return FlowTransition.DEFAULT;
  }
}
