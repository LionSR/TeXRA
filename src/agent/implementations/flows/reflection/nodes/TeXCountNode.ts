/**
 * TeXCountNode - Computes TeXCount statistics and adds to messages.
 *
 * Single responsibility: Run TeXCount and prepend stats to user message.
 * Uses shared helper for file determination (DRY).
 *
 * PocketFlow pattern:
 * - prep(): Determine files to count, get context
 * - exec(): Run TeXCount (can fail gracefully)
 * - post(): Prepend stats to messages via modelHandler
 *
 * Services accessed via native `this.services`:
 * - config, fileService, modelHandler, logger
 */

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { SkippableNodeResult } from '@agent/core/flows/CommonCycleTypes';
import {
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import type { FileLocation } from '@utils/files';
import { getTeXCountStats } from '@latex';

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

interface TeXCountPrepInput {
  files: FileLocation[];
  attachTeXCount: boolean;
  context: RoundContext | null;
}

type TeXCountExecResult = SkippableNodeResult<string>;

// ============================================================================
// Node Implementation
// ============================================================================

export class TeXCountNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(shared: ReflectionFlowShared): Promise<TeXCountPrepInput> {
    const { config, fileService } = this.services;
    const { currentRound, roundOutputs, context } = shared;

    const files = getFilesForRound(
      currentRound,
      roundOutputs,
      config,
      fileService,
    );

    return {
      files,
      attachTeXCount: config.toolConfig.attachTeXCount,
      context,
    };
  }

  async exec(prepRes: TeXCountPrepInput): Promise<TeXCountExecResult> {
    // Skip if not enabled or no files
    if (!prepRes.attachTeXCount || prepRes.files.length === 0) {
      return { kind: 'skipped' };
    }

    const stats = await getTeXCountStats(
      prepRes.files.map((f) => f.absolutePath),
    );

    if (!stats) {
      return { kind: 'skipped' };
    }

    return { kind: 'success', value: stats };
  }

  async execFallback(
    _prepRes: TeXCountPrepInput,
    _error: Error,
  ): Promise<TeXCountExecResult> {
    return { kind: 'skipped' };
  }

  async post(
    shared: ReflectionFlowShared,
    _prepRes: TeXCountPrepInput,
    execRes: TeXCountExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'skipped') {
      return FlowTransition.DEFAULT;
    }

    if (shared.context) {
      this.services.modelHandler.prependTextToUserMessage(
        shared.context.messages,
        execRes.value,
      );
    }

    return FlowTransition.DEFAULT;
  }
}
