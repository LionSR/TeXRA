/**
 * TeXCountNode - Computes TeXCount statistics.
 *
 * Single responsibility: Run TeXCount and store stats.
 * Uses shared helper for file determination (DRY).
 *
 * PocketFlow pattern:
 * - prep(): Determine files to count using shared helper
 * - exec(): Run TeXCount (can fail gracefully)
 * - post(): Store stats in workspaceState
 *
 * Services accessed via native `this.services`:
 * - config, fileService, logger
 */

import { Node } from '@agent/node';
import type { FileLocation } from '@utils/files';
import { getTeXCountStats } from '@latex';

import { getFilesForRound } from '../helpers';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
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
    super(1, 0); // maxRetries=1, wait=0
  }

  /**
   * Determine which files to count using shared helper.
   */
  async prep(shared: ReflectionFlowShared): Promise<TeXCountPrepInput> {
    const { config, fileService } = this.services;
    const { currentRound, roundOutputs } = shared.state;

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
   * Store stats in workspaceState and continue.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: TeXCountPrepInput,
    execRes: TeXCountExecResult,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    // Store stats in workspace state
    if (execRes.stats) {
      shared.state.workspaceState.document.texcountStats = execRes.stats;
    }

    // Log warning if degraded
    if (execRes.kind === 'degraded') {
      logger.warn(execRes.warning);
    }

    // Continue to next node
    return undefined;
  }
}
