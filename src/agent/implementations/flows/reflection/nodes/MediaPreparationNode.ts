/**
 * MediaPreparationNode - Extracts media files (figures, TikZ, PDFs) and adds to messages.
 *
 * Single responsibility: Extract media and add to user message.
 * Uses shared helper for file determination (DRY).
 *
 * PocketFlow pattern:
 * - prep(): Determine files using shared helper, get context
 * - exec(): Extract media (mutates shared.workspace directly)
 * - post(): Add media to messages via modelHandler
 *
 * Note: latexMediaManager mutates shared.workspace in place for media extraction,
 * then we add the extracted files to messages via modelHandler.
 * Serialization hooks handle persistence - no manual snapshot updates needed.
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
import type { FileLocation } from '@utils/files';

import { getFilesForRound } from '../helpers';
import type { ReflectionFlowShared, RoundContext } from '../ReflectionFlowState';
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
  context: RoundContext | null;
  /** Live workspace instance - mutations persist automatically */
  workspace: import('@agent/core/AgentWorkspaceState').AgentWorkspaceState;
}

interface MediaExecResult {
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
   * Determine files using shared helper and collect extra media.
   */
  async prep(shared: ReflectionFlowShared): Promise<MediaPrepInput> {
    const { config, fileService, modelHandler } = this.services;
    const { currentRound, roundOutputs, context, workspace } = shared;

    const files = getFilesForRound(currentRound, roundOutputs, config, fileService);

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
      context,
      workspace, // Live instance - mutations persist automatically
    };
  }

  /**
   * Extract media from files.
   * Mutates prepRes.workspace - it's a live instance, mutations persist automatically.
   */
  async exec(prepRes: MediaPrepInput): Promise<MediaExecResult> {
    const { latexMediaManager, config, logger } = this.services;

    if (!prepRes.supportsVision || prepRes.files.length === 0) {
      logger.debug('Media extraction skipped: no vision support or no files');
      return { mediaFiles: [] };
    }

    // Mutate workspace directly - it's a live instance from shared
    if (prepRes.currentRound === 0) {
      await latexMediaManager.processInputFiles(
        prepRes.files,
        prepRes.workspace,
        config.toolConfig,
        true,
        prepRes.extraMediaFiles,
      );
    } else {
      await latexMediaManager.processOutputFiles(
        prepRes.files,
        prepRes.workspace,
        config.toolConfig,
        true,
      );
    }

    const mediaFiles = prepRes.workspace.media.files;
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
   * Add media to messages via modelHandler and continue.
   * No need to update snapshots - workspace is a live instance.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: MediaPrepInput,
    execRes: MediaExecResult,
  ): Promise<string | undefined> {
    const { modelHandler, logger } = this.services;

    if (execRes.mediaFiles.length > 0 && shared.context) {
      await modelHandler.addMediaToUserMessage(
        shared.context.messages,
        execRes.mediaFiles,
      );
      logger.debug(
        `${execRes.mediaFiles.length} media files added to user message`,
      );
    }

    return FlowTransition.DEFAULT;
  }
}
