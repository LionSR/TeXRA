/**
 * PrepareContextNode - Prepares round context (prompts and messages).
 *
 * Responsibilities:
 * - Build prompts via promptBuilder
 * - Prepend TeXCount stats to user content
 * - Initialize messages via modelHandler
 *
 * PocketFlow pattern:
 * - prep(): Extract data needed for context preparation
 * - exec(): Build prompts and messages
 * - post(): Store context in shared, handle skip
 *
 * Services accessed via native `this.services`:
 * - promptBuilder, modelHandler, logger
 */

import { Node } from '@agent/node';
import { ConversationRoundState } from '@agent/core/AgentState';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

import { prependTexCountStats } from '../helpers';

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
  workspaceState: AgentWorkspaceState;
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
    super(1, 0); // maxRetries=1, wait=0
  }

  /**
   * Extract data needed for context preparation.
   */
  async prep(shared: ReflectionFlowShared): Promise<ContextPrepInput> {
    return {
      currentRound: shared.state.currentRound,
      workspaceState: shared.state.workspaceState,
      conversation: shared.state.conversation,
    };
  }

  /**
   * Build prompts and messages for the round.
   */
  async exec(prepRes: ContextPrepInput): Promise<ContextExecResult> {
    const { promptBuilder, modelHandler, logger } = this.services;
    const { currentRound, workspaceState, conversation } = prepRes;

    const stateRound = new ConversationRoundState(currentRound);

    if (currentRound === 0) {
      // First round: build initial prompts
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();

      // Prepend TeXCount stats using shared helper (DRY)
      const prefixWithStats = prependTexCountStats(
        userPrefix,
        workspaceState.document.texcountStats,
      );

      // Build prefill
      const prefill = await promptBuilder.buildPrefill(currentRound);

      // Initialize messages via model handler
      const messages = await modelHandler.initializeMessages(
        prefixWithStats,
        userRequest,
        workspaceState.media.files,
        systemPrompt,
      );

      logger.debug(
        `Prepared first round context with ${messages.length} messages`,
      );

      return {
        kind: 'ready',
        context: { messages, prefill: prefill ?? '', stateRound },
      };
    } else {
      // Subsequent rounds: build user request only
      const userRequest = await promptBuilder.buildUserRequest(currentRound);

      // Prepend TeXCount stats using shared helper (DRY)
      const userMessage = prependTexCountStats(
        userRequest ?? '',
        workspaceState.document.texcountStats,
      );

      // Check for skip (no content)
      if (!userMessage.trim()) {
        logger.debug(`Skipping round ${currentRound} - no user content`);
        return { kind: 'skip' };
      }

      // Build prefill
      const prefill = await promptBuilder.buildPrefill(currentRound);

      // Create round messages via model handler
      const messages = await modelHandler.createRoundMessages(
        conversation,
        userMessage,
        workspaceState.media.files,
      );

      logger.debug(
        `Prepared round ${currentRound} context with ${messages.length} messages`,
      );

      return {
        kind: 'ready',
        context: { messages, prefill: prefill ?? '', stateRound },
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
      // Increment round and loop back to PrepareWorkspaceNode
      shared.state.currentRound += 1;
      return FlowTransition.CONTINUE;
    }

    // Store context for ResponseCycleNode
    shared.state.context = execRes.context;

    // Continue to ResponseCycleNode
    return undefined;
  }
}
