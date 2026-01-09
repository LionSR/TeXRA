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
import type { FileLocation } from '@utils/files';

import { getFilesForRound } from '../helpers';
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
  filesForRound: FileLocation[];
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

  /**
   * Extract data needed for context preparation.
   * Computes filesForRound here to avoid redundant calls in subsequent nodes.
   */
  async prep(shared: ReflectionFlowShared): Promise<ContextPrepInput> {
    const { config, fileService } = this.services;
    const { currentRound, conversation, roundOutputs } = shared;

    // Compute filesForRound once here, reused by TeXCountNode and MediaExtractionNode
    const filesForRound = getFilesForRound(
      currentRound,
      roundOutputs,
      config,
      fileService,
    );

    return {
      currentRound,
      conversation,
      filesForRound,
    };
  }

  /**
   * Build prompts and base messages for the round.
   * Does NOT include texcount stats or media - those are added by subsequent nodes.
   */
  async exec(prepRes: ContextPrepInput): Promise<ContextExecResult> {
    const { promptBuilder, modelHandler, logger } = this.services;
    const { currentRound, conversation, filesForRound } = prepRes;

    const stateRound = new ConversationRoundState(currentRound);

    if (currentRound === 0) {
      // First round: build initial prompts
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();

      // Build prefill
      const prefill = await promptBuilder.buildPrefill(currentRound);

      // Initialize base messages (no media - will be added by MediaExtractionNode)
      const messages = await modelHandler.initializeMessages(
        userPrefix,
        userRequest,
        undefined, // media added later by MediaExtractionNode
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
          filesForRound,
        },
      };
    } else {
      // Subsequent rounds: build user request only
      const userRequest = await promptBuilder.buildUserRequest(currentRound);

      // Build prefill
      const prefill = await promptBuilder.buildPrefill(currentRound);

      // Create round messages (no media - will be added by MediaExtractionNode)
      const messages = await modelHandler.createRoundMessages(
        conversation,
        userRequest,
        undefined, // media added later by MediaExtractionNode
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
          filesForRound,
        },
      };
    }
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
