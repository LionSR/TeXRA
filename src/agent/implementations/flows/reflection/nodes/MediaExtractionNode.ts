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
import type { SkippableNodeResult } from '@agent/core/flows/CommonCycleTypes';
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

interface MediaExecSuccess {
  mediaFiles: FileLocation[];
}

type MediaExecResult = SkippableNodeResult<MediaExecSuccess>;

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

  async prep(shared: ReflectionFlowShared): Promise<MediaPrepInput> {
    const { config, fileService, modelHandler } = this.services;
    const { currentRound, roundOutputs, context } = shared;

    const workspaceState = getWorkspaceState(shared);

    const files = getFilesForRound(
      currentRound,
      roundOutputs,
      config,
      fileService,
    );

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

  async exec(prepRes: MediaPrepInput): Promise<MediaExecResult> {
    const { latexMediaManager, config } = this.services;

    // Skip if model doesn't support vision or no files
    if (!prepRes.supportsVision || prepRes.files.length === 0) {
      return { kind: 'skipped' };
    }

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

    const mediaFiles = prepRes.workspaceState.media.files;
    return { kind: 'success', value: { mediaFiles } };
  }

  async execFallback(
    _prepRes: MediaPrepInput,
    _error: Error,
  ): Promise<MediaExecResult> {
    return { kind: 'skipped' };
  }

  async post(
    shared: ReflectionFlowShared,
    prepRes: MediaPrepInput,
    execRes: MediaExecResult,
  ): Promise<string | undefined> {
    const { modelHandler } = this.services;

    // Always update workspace snapshot since prep() reconstructed it
    updateWorkspaceSnapshot(shared, prepRes.workspaceState);

    if (execRes.kind === 'skipped') {
      return FlowTransition.DEFAULT;
    }

    const { mediaFiles } = execRes.value;
    if (mediaFiles.length > 0 && shared.context) {
      await modelHandler.addMediaToUserMessage(
        shared.context.messages,
        mediaFiles,
      );
    }

    return FlowTransition.DEFAULT;
  }
}
