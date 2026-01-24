/**
 * MediaExtractionNode - Extracts media files (figures, TikZ, PDFs) from LaTeX files.
 */

// Local imports - agent
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { Node } from '@agent/node';

// Local imports - shared schemas
import type { FileLocation } from '@shared/schemas';

// Local file imports
import { getFilesForRound } from '../helpers';
import type {
  ReflectionFlowShared,
  RoundContext,
} from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

interface PrepInput {
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
  async prep(shared: ReflectionFlowShared): Promise<PrepInput> {
    const { config, fileService, modelHandler } = this.services;
    const { currentRound, roundOutputs, context } = shared;

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
      files: getFilesForRound(currentRound, roundOutputs, config, fileService),
      currentRound,
      supportsVision: modelHandler.capabilities.supportsVision,
      extraMediaFiles,
      workspaceState,
      context,
    };
  }

  async exec(prepRes: PrepInput): Promise<FileLocation[] | null> {
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
    _prepRes: PrepInput,
    error: Error,
  ): Promise<FileLocation[] | null> {
    this.services.logger.debug(`Media extraction skipped: ${error.message}`);
    return null;
  }

  async post(
    shared: ReflectionFlowShared,
    prepRes: PrepInput,
    mediaFiles: FileLocation[] | null,
  ): Promise<string | undefined> {
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
