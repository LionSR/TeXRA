/**
 * MediaPreparationNode - Extracts media files (figures, TikZ, PDFs) and adds to messages.
 *
 * Single responsibility: Extract media and add to user message.
 * Uses shared helper for file determination (DRY).
 *
 * PocketFlow pattern:
 * - prep(): Determine files using shared helper, prepare isolated workspace for extraction
 * - exec(): Extract media into isolated workspace (compute-only, no shared state mutation)
 * - post(): Merge extracted media into actual workspaceState, add to messages
 *
 * Note: We use an isolated AgentWorkspaceState for media extraction in exec() to
 * maintain PocketFlow's principle that exec() should be compute-only with no
 * side effects on shared state. The extracted media is merged in post().
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
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { toErrorMessage } from '@common/errors';
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
  /** Isolated workspace for media extraction - NOT the shared state */
  isolatedWorkspace: AgentWorkspaceState;
  context: RoundContext | null;
}

interface MediaExecResult {
  /** Media files extracted into the isolated workspace */
  mediaFiles: FileLocation[];
}

// ============================================================================
// Node Implementation
// ============================================================================

export class MediaPreparationNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  /**
   * Determine files using shared helper and create isolated workspace for extraction.
   *
   * Creates a fresh AgentWorkspaceState for media extraction to ensure exec()
   * doesn't mutate the shared state. Media will be merged in post().
   */
  async prep(shared: ReflectionFlowShared): Promise<MediaPrepInput> {
    const { config, fileService, modelHandler } = this.services;
    const { currentRound, roundOutputs, context } = shared;

    // Create an ISOLATED workspace for media extraction
    // This ensures exec() doesn't mutate shared state (PocketFlow principle)
    const isolatedWorkspace = AgentWorkspaceState.create();

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
      isolatedWorkspace,
      context,
    };
  }

  /**
   * Extract media from files into the isolated workspace.
   *
   * This method is compute-only from the perspective of shared state:
   * - It mutates the ISOLATED workspace (created fresh in prep())
   * - It does NOT access or mutate the shared state
   * - Extracted media is merged into shared state in post()
   *
   * This satisfies PocketFlow's principle that exec() should not have
   * side effects on shared state, enabling safe retries.
   */
  async exec(prepRes: MediaPrepInput): Promise<MediaExecResult> {
    const { latexMediaManager, config, logger } = this.services;

    // Skip if model doesn't support vision or no files
    if (!prepRes.supportsVision || prepRes.files.length === 0) {
      logger.debug('Media extraction skipped: no vision support or no files');
      return { mediaFiles: [] };
    }

    // Extract media into the ISOLATED workspace (not shared state)
    // Different processing for first round vs subsequent rounds
    if (prepRes.currentRound === 0) {
      await latexMediaManager.processInputFiles(
        prepRes.files,
        prepRes.isolatedWorkspace,
        config.toolConfig,
        true,
        prepRes.extraMediaFiles,
      );
    } else {
      await latexMediaManager.processOutputFiles(
        prepRes.files,
        prepRes.isolatedWorkspace,
        config.toolConfig,
        true,
      );
    }

    // Return extracted media files (to be merged in post())
    const mediaFiles = prepRes.isolatedWorkspace.media.files;
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
   * Merge extracted media into shared state and add to messages.
   *
   * This is where we apply the results from exec() to the shared state,
   * following PocketFlow's principle that post() is for writing back to shared.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: MediaPrepInput,
    execRes: MediaExecResult,
  ): Promise<string | undefined> {
    const { modelHandler, logger } = this.services;

    // Merge extracted media into the actual workspaceState
    if (execRes.mediaFiles.length > 0) {
      // Reconstruct workspace, add media, then update snapshot
      const workspaceState = getWorkspaceState(shared);
      workspaceState.media.addMediaFiles(execRes.mediaFiles);
      updateWorkspaceSnapshot(shared, workspaceState);

      // Add media to messages if we have context
      if (shared.context) {
        await modelHandler.addMediaToUserMessage(
          shared.context.messages,
          execRes.mediaFiles,
        );
        logger.debug(
          `${execRes.mediaFiles.length} media files added to user message`,
        );
      }
    }

    // Continue to next node
    return FlowTransition.DEFAULT;
  }
}
