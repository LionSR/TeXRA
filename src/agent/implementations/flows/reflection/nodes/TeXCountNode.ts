/**
 * TeXCountNode - Initializes workspace and computes TeXCount statistics.
 *
 * This is the first node in each round's processing pipeline.
 * It creates a fresh workspace state and optionally computes TeXCount stats.
 *
 * Responsibilities:
 * - Create fresh AgentWorkspaceState for the round
 * - Compute TeXCount statistics (can fail gracefully)
 *
 * PocketFlow pattern:
 * - prep(): Create workspace state, determine files to count
 * - exec(): Run TeXCount (can fail gracefully)
 * - post(): Store stats in workspaceState
 *
 * Services accessed via `_params.services`:
 * - config, fileService, logger
 */

import { Node } from '@agent/node';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { FileLocation } from '@utils/files';
import { getTeXCountStats } from '@latex';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type { ReflectionFlowParams } from '../ReflectionServices';

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
  ReflectionFlowParams<C>
> {
  constructor() {
    super(1, 0); // maxRetries=1, wait=0
  }

  /**
   * Initialize workspace state and determine which files to count.
   */
  async prep(shared: ReflectionFlowShared): Promise<TeXCountPrepInput> {
    const { config, fileService, logger } = this._params.services;
    const { currentRound, roundOutputs } = shared.state;

    // Create fresh workspace state for this round
    shared.state.workspaceState = AgentWorkspaceState.create();
    logger.debug(`Workspace state initialized for round ${currentRound}`);

    // Determine files to process based on round
    let files: FileLocation[];

    if (currentRound === 0) {
      // First round: count input files
      files = [
        fileService.createLocation(config.inputFile),
        ...config.inputFiles.map((f) => fileService.createLocation(f)),
      ];
    } else {
      // Subsequent rounds: count previous round's outputs
      const prevOutput = roundOutputs[currentRound - 1];
      if (prevOutput && prevOutput.outputs.length > 0) {
        files = prevOutput.outputs.map((o) => o.location);
      } else if (config.outputFiles.length > 0) {
        files = config.outputFiles.map((f) => fileService.createLocation(f));
      } else {
        files = [];
      }
    }

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
    const { logger } = this._params.services;

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
    const { logger } = this._params.services;

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
