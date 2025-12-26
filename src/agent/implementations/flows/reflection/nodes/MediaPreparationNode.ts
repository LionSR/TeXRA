/**
 * MediaPreparationNode - Extracts media files (figures, TikZ, PDFs).
 *
 * Standalone node that focuses ONLY on media extraction.
 * Separated from TeXCount to follow single responsibility principle.
 *
 * PocketFlow pattern:
 * - prep(): Determine which files to process, get workspaceState reference
 * - exec(): Extract media (mutates workspaceState via latexMediaManager)
 * - post(): Log warnings if degraded
 *
 * Note: latexMediaManager mutates workspaceState in place, so we pass
 * the reference through prep. This is a slight bend of pure PocketFlow
 * but necessary for the current API.
 *
 * Services accessed via `_params.services`:
 * - latexMediaManager, config, fileService, modelHandler, logger
 */

import { Node } from '@agent/node';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { FileLocation } from '@utils/files';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type { ReflectionFlowParams } from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

interface MediaPrepInput {
  files: FileLocation[];
  currentRound: number;
  supportsVision: boolean;
  extraMediaFiles: FileLocation[];
  workspaceState: AgentWorkspaceState;
}

type MediaExecResult =
  | { kind: 'success' }
  | { kind: 'degraded'; warning: string };

// ============================================================================
// Node Implementation
// ============================================================================

export class MediaPreparationNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams<C>
> {
  constructor() {
    super(1, 0); // maxRetries=1, wait=0
  }

  /**
   * Determine which files to process for media.
   * Also passes workspaceState reference for latexMediaManager.
   */
  async prep(shared: ReflectionFlowShared): Promise<MediaPrepInput> {
    const { config, fileService, modelHandler } = this._params.services;
    const { currentRound, roundOutputs, workspaceState } = shared.state;

    // Determine files to process based on round
    let files: FileLocation[];

    if (currentRound === 0) {
      // First round: process input files
      files = [
        fileService.createLocation(config.inputFile),
        ...config.inputFiles.map((f) => fileService.createLocation(f)),
      ];
    } else {
      // Subsequent rounds: process previous round's output files
      const prevOutput = roundOutputs[currentRound - 1];
      if (prevOutput && prevOutput.outputs.length > 0) {
        files = prevOutput.outputs.map((o) => o.location);
      } else if (config.outputFiles.length > 0) {
        files = config.outputFiles.map((f) => fileService.createLocation(f));
      } else {
        files = [];
      }
    }

    // Collect extra media files for first round
    const extraMediaFiles: FileLocation[] = [];
    if (currentRound === 0 && modelHandler.capabilities.supportsVision) {
      if (config.mediaFile) {
        extraMediaFiles.push(fileService.createLocation(config.mediaFile));
      }
      for (const mediaPath of config.mediaFiles) {
        extraMediaFiles.push(fileService.createLocation(mediaPath));
      }
    }

    return {
      files,
      currentRound,
      supportsVision: modelHandler.capabilities.supportsVision,
      extraMediaFiles,
      workspaceState,
    };
  }

  /**
   * Extract media from files.
   * Mutates workspaceState via latexMediaManager.
   * This can fail gracefully - media extraction failures shouldn't stop the flow.
   */
  async exec(prepRes: MediaPrepInput): Promise<MediaExecResult> {
    const { latexMediaManager, config, logger } = this._params.services;

    // Skip if model doesn't support vision or no files
    if (!prepRes.supportsVision || prepRes.files.length === 0) {
      logger.debug('Media extraction skipped: no vision support or no files');
      return { kind: 'success' };
    }

    try {
      // Different processing for first round vs subsequent rounds
      if (prepRes.currentRound === 0) {
        await latexMediaManager.processInputFiles(
          prepRes.files,
          prepRes.workspaceState,
          config.toolConfig,
          true,
          prepRes.extraMediaFiles,
        );
      } else {
        await latexMediaManager.processOutputFiles(
          prepRes.files,
          prepRes.workspaceState,
          config.toolConfig,
          true,
        );
      }

      logger.debug(`Media extracted from ${prepRes.files.length} files`);
      return { kind: 'success' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        kind: 'degraded',
        warning: `Media extraction failed: ${message}`,
      };
    }
  }

  /**
   * Handle total failure - continue without media.
   */
  async execFallback(
    _prepRes: MediaPrepInput,
    error: Error,
  ): Promise<MediaExecResult> {
    return {
      kind: 'degraded',
      warning: `Media extraction failed: ${error.message}`,
    };
  }

  /**
   * Log warning if degraded and continue.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: MediaPrepInput,
    execRes: MediaExecResult,
  ): Promise<string | undefined> {
    const { logger } = this._params.services;

    // Log warning if degraded
    if (execRes.kind === 'degraded') {
      logger.warn(execRes.warning);
    }

    // Continue to next node
    return undefined;
  }
}
