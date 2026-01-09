/**
 * MediaExtractionNode - Extracts media files (figures, TikZ, PDFs) from LaTeX files.
 *
 * Note: exec() mutates workspaceState via latexMediaManager. This is acceptable
 * because NODE_NO_RETRY means no retries, so no duplicate mutations possible.
 */

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { FileLocation } from '@utils/files';

import { getFilesForRound } from '../helpers';

import {
  type ReflectionFlowShared,
  type RoundContext,
} from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

interface MediaPrepInput {
  files: FileLocation[];
  currentRound: number;
  supportsVision: boolean;
  extraMediaFiles: FileLocation[];
  workspaceState: AgentWorkspaceState;
  context: RoundContext | null;
}

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

    const workspaceState = AgentWorkspaceState.fromSnapshot(
      shared.workspaceSnapshot,
    );
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

  async exec(prepRes: MediaPrepInput): Promise<FileLocation[] | null> {
    if (!prepRes.supportsVision || prepRes.files.length === 0) {
      return null;
    }

    const { latexMediaManager, config } = this.services;

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

    return prepRes.workspaceState.media.files;
  }

  async execFallback(
    _prepRes: MediaPrepInput,
    error: Error,
  ): Promise<FileLocation[] | null> {
    this.services.logger.debug(`Media extraction skipped: ${error.message}`);
    return null;
  }

  async post(
    shared: ReflectionFlowShared,
    prepRes: MediaPrepInput,
    mediaFiles: FileLocation[] | null,
  ): Promise<string | undefined> {
    // Always update workspace snapshot since prep() reconstructed it
    shared.workspaceSnapshot = prepRes.workspaceState.toSnapshot();

    if (mediaFiles && mediaFiles.length > 0 && shared.context) {
      await this.services.modelHandler.addMediaToUserMessage(
        shared.context.messages,
        mediaFiles,
      );
    }

    return FlowTransition.DEFAULT;
  }
}
