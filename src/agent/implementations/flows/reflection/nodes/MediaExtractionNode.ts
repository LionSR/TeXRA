/**
 * MediaExtractionNode - Extracts media files (figures, TikZ, PDFs) from LaTeX files.
 */

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { FileLocation } from '@utils/files';

import { getFilesForRound } from '../helpers';
import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

/**
 * Prep result carries shared reference and computed values.
 * - workspaceState: reconstructed from snapshot, modified in exec, saved in post
 * - files/extraMediaFiles: computed once to avoid redundant calls
 */
interface PrepInput {
  shared: ReflectionFlowShared;
  files: FileLocation[];
  extraMediaFiles: FileLocation[];
  workspaceState: AgentWorkspaceState;
}

export class MediaExtractionNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<PrepInput> {
    const { config, fileService, modelHandler } = this.services;
    const { currentRound, roundOutputs } = shared;

    const workspaceState = AgentWorkspaceState.fromSnapshot(
      shared.workspaceSnapshot,
    );

    const extraMediaFiles: FileLocation[] = [];
    if (currentRound === 0 && modelHandler.capabilities.supportsVision) {
      if (config.mediaFile) {
        extraMediaFiles.push(fileService.createLocation(config.mediaFile));
      }
      for (const p of config.mediaFiles) {
        extraMediaFiles.push(fileService.createLocation(p));
      }
    }

    return {
      shared,
      files: getFilesForRound(currentRound, roundOutputs, config, fileService),
      extraMediaFiles,
      workspaceState,
    };
  }

  async exec(prepRes: PrepInput): Promise<FileLocation[] | null> {
    const { modelHandler, latexMediaManager, config } = this.services;

    if (
      !modelHandler.capabilities.supportsVision ||
      prepRes.files.length === 0
    ) {
      return null;
    }

    if (prepRes.shared.currentRound === 0) {
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
    _prepRes: PrepInput,
    error: Error,
  ): Promise<FileLocation[] | null> {
    const { logger } = this.services;
    logger.debug(`Media extraction skipped: ${error.message}`);
    return null;
  }

  async post(
    _shared: ReflectionFlowShared,
    prepRes: PrepInput,
    mediaFiles: FileLocation[] | null,
  ): Promise<string | undefined> {
    prepRes.shared.workspaceSnapshot = prepRes.workspaceState.toSnapshot();

    if (mediaFiles && mediaFiles.length > 0 && prepRes.shared.context) {
      await this.services.modelHandler.addMediaToUserMessage(
        prepRes.shared.context.messages,
        mediaFiles,
      );
    }

    return FlowTransition.DEFAULT;
  }
}
