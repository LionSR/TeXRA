/**
 * MediaPreparationNode - Extracts media files (figures, TikZ, PDFs) and adds to messages.
 *
 * Single responsibility: Extract media and add to user message.
 * Uses shared helper for file determination (DRY).
 *
 * PocketFlow pattern:
 * - prep(): Determine files using shared helper, get context
 * - exec(): Extract media (mutates workspaceState via latexMediaManager)
 * - post(): Add media to messages via modelHandler, log warnings if degraded
 *
 * Note: latexMediaManager mutates workspaceState in place for media extraction,
 * then we add the extracted files to messages via modelHandler.
 *
 * Services accessed via native `this.services`:
 * - latexMediaManager, config, fileService, modelHandler, logger
 */

import { Node } from '@agent/node';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
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

interface MediaPrepInput {
  files: FileLocation[];
  currentRound: number;
  supportsVision: boolean;
  extraMediaFiles: FileLocation[];
  workspaceState: AgentWorkspaceState;
  context: RoundContext | null;
}

type MediaExecResult =
  | { kind: 'success'; mediaFiles: FileLocation[] }
  | { kind: 'degraded'; mediaFiles: FileLocation[]; warning: string };

// ============================================================================
// Node Implementation
// ============================================================================

export class MediaPreparationNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  constructor() {
    super(1, 0); // maxRetries=1, wait=0
  }

  /**
   * Determine files using shared helper and collect extra media.
   */
  async prep(shared: ReflectionFlowShared): Promise<MediaPrepInput> {
    const { config, fileService, modelHandler } = this.services;
    const { currentRound, roundOutputs, workspaceState, context } =
      shared.state;

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
   * This can fail gracefully - media extraction failures shouldn't stop the flow.
   */
  async exec(prepRes: MediaPrepInput): Promise<MediaExecResult> {
    const { latexMediaManager, config, logger } = this.services;

    // Skip if model doesn't support vision or no files
    if (!prepRes.supportsVision || prepRes.files.length === 0) {
      logger.debug('Media extraction skipped: no vision support or no files');
      return { kind: 'success', mediaFiles: [] };
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

      // Collect media files from workspaceState
      const mediaFiles = prepRes.workspaceState.media.files;
      logger.debug(
        `Media extracted from ${prepRes.files.length} files: ${mediaFiles.length} media items`,
      );
      return { kind: 'success', mediaFiles };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        kind: 'degraded',
        mediaFiles: [],
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
      mediaFiles: [],
      warning: `Media extraction failed: ${error.message}`,
    };
  }

  /**
   * Add media to messages via modelHandler and continue.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: MediaPrepInput,
    execRes: MediaExecResult,
  ): Promise<string | undefined> {
    const { modelHandler, logger } = this.services;

    // Log warning if degraded
    if (execRes.kind === 'degraded') {
      logger.warn(execRes.warning);
    }

    // Add media to messages if we have files and context
    if (execRes.mediaFiles.length > 0 && shared.state.context) {
      await modelHandler.addMediaToUserMessage(
        shared.state.context.messages,
        execRes.mediaFiles,
      );
      logger.debug(
        `${execRes.mediaFiles.length} media files added to user message`,
      );
    }

    // Continue to next node
    return undefined;
  }
}
