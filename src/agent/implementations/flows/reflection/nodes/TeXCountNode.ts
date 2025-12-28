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

type TeXCountExecResult =
  | { kind: 'success'; stats: string | null }
  | { kind: 'degraded'; stats: null; warning: string };

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

  /**
   * Determine which files to count using shared helper.
   */
  async prep(shared: ReflectionFlowShared): Promise<TeXCountPrepInput> {
    const { config, fileService } = this.services;
    const { currentRound, roundOutputs, context } = shared.state;

    // Use shared helper for file determination (DRY)
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

  /**
   * Run TeXCount.
   * This can fail gracefully - missing texcount shouldn't stop the flow.
   */
  async exec(prepRes: TeXCountPrepInput): Promise<TeXCountExecResult> {
    const { logger } = this.services;

    // Skip if not enabled or no files
    if (!prepRes.attachTeXCount || prepRes.files.length === 0) {
      logger.debug('TeXCount skipped: not enabled or no files');
      return { kind: 'success', stats: null };
    }

    try {
      const stats = await getTeXCountStats(
        prepRes.files.map((f) => f.absolutePath),
      );
      logger.debug(`TeXCount computed for ${prepRes.files.length} files`);
      return { kind: 'success', stats: stats ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        kind: 'degraded',
        stats: null,
        warning: `TeXCount failed: ${message}`,
      };
    }
  }

  /**
   * Handle total failure - continue without stats.
   */
  async execFallback(
    _prepRes: TeXCountPrepInput,
    error: Error,
  ): Promise<TeXCountExecResult> {
    return {
      kind: 'degraded',
      stats: null,
      warning: `TeXCount failed: ${error.message}`,
    };
  }

  /**
   * Prepend stats to messages via modelHandler and continue.
   */
  async post(
    shared: ReflectionFlowShared,
    prepRes: TeXCountPrepInput,
    execRes: TeXCountExecResult,
  ): Promise<string | undefined> {
    const { modelHandler, logger } = this.services;

    // Log warning if degraded
    if (execRes.kind === 'degraded') {
      logger.warn(execRes.warning);
    }

    // Prepend stats to messages if we have stats and context
    if (execRes.stats && shared.state.context) {
      modelHandler.prependTextToUserMessage(
        shared.state.context.messages,
        execRes.stats,
      );
      logger.debug('TeXCount stats prepended to user message');
    }

    // Continue to next node
    return undefined;
  }
}
