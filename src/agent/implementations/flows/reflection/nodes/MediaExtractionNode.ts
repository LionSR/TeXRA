/**
 * MediaExtractionNode - Extracts media files (figures, TikZ, PDFs) from LaTeX files.
 *
 * Single responsibility: Extract media from input/output files and add to user message.
 * Uses shared helper for file determination (DRY).
 *
 * PocketFlow pattern:
 * - prep(): Determine files, reconstruct workspace from snapshot
 * - exec(): Extract media via latexMediaManager (mutates workspace)
 * - post(): Update snapshot, add media to messages
 *
 * Note: exec() mutates workspaceState via latexMediaManager. This is acceptable
 * because NODE_NO_RETRY means no retries, so no duplicate mutations possible.
 *
 * Services accessed via native `this.services`:
 * - latexMediaManager, config, fileService, modelHandler, logger
 */

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { FileLocation } from '@utils/files';

import { getFilesForRound } from '../helpers';

import {
  getWorkspaceState,
  updateWorkspaceSnapshot,
  type ReflectionFlowShared,
  type RoundContext,
} from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

interface MediaPrepInput {
  files: FileLocation[];
  currentRound: number;
  supportsVision: boolean;
  extraMediaFiles: FileLocation[];
  workspaceState: AgentWorkspaceState;
  context: RoundContext | null;
}

interface MediaExecResult {
  mediaFiles: FileLocation[];
}

// ============================================================================
// Node Implementation
// ============================================================================

export class MediaExtractionNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  /**
   * Determine files and reconstruct workspace from snapshot.
   */
  async prep(shared: ReflectionFlowShared): Promise<MediaPrepInput> {
    const { config, fileService, modelHandler } = this.services;
    const { currentRound, roundOutputs, context } = shared;

    // Reconstruct workspace state from snapshot
    const workspaceState = getWorkspaceState(shared);

    // Use shared helper for file determination (DRY)
    const files = getFilesForRound(
      currentRound,
      roundOutputs,
      config,
      fileService,
    );

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
      context,
    };
  }

  /**
   * Extract media from files.
   * Mutates workspaceState via latexMediaManager to collect media files.
   */
  async exec(prepRes: MediaPrepInput): Promise<MediaExecResult> {
    const { latexMediaManager, config, logger } = this.services;

    // Skip if model doesn't support vision or no files
    if (!prepRes.supportsVision || prepRes.files.length === 0) {
      logger.debug('Media extraction skipped: no vision support or no files');
      return { mediaFiles: [] };
    }

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

    // Collect media files from workspaceState
    const mediaFiles = prepRes.workspaceState.media.files;
    logger.debug(
      `Media extracted from ${prepRes.files.length} files: ${mediaFiles.length} media items`,
    );
    return { mediaFiles };
  }

  /**
   * Handle total failure - log warning and continue without media.
   */
  async execFallback(
    _prepRes: MediaPrepInput,
    error: Error,
  ): Promise<MediaExecResult> {
    this.services.logger.warn(`Media extraction failed: ${error.message}`);
    return { mediaFiles: [] };
  }

  /**
   * Update snapshot and add media to messages.
   */
  async post(
    shared: ReflectionFlowShared,
    prepRes: MediaPrepInput,
    execRes: MediaExecResult,
  ): Promise<string | undefined> {
    const { modelHandler, logger } = this.services;

    // Update workspace snapshot (exec mutated workspaceState)
    updateWorkspaceSnapshot(shared, prepRes.workspaceState);

    // Add media to messages if we have files and context
    if (execRes.mediaFiles.length > 0 && shared.context) {
      await modelHandler.addMediaToUserMessage(
        shared.context.messages,
        execRes.mediaFiles,
      );
      logger.debug(
        `${execRes.mediaFiles.length} media files added to user message`,
      );
    }

    // Continue to next node
    return FlowTransition.DEFAULT;
  }
}
