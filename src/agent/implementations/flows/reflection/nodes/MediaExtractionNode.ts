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

interface PrepInput {
  files: FileLocation[];
  extraMediaFiles: FileLocation[];
  workspaceState: AgentWorkspaceState;
  currentRound: number;
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
      extraMediaFiles.push(
        ...config.mediaFiles.map((p) => fileService.createLocation(p)),
      );
    }

    return {
      currentRound,
      files: getFilesForRound(currentRound, roundOutputs, config, fileService),
      extraMediaFiles,
      workspaceState,
    };
  }

  async exec(prepRes: PrepInput): Promise<FileLocation[] | null> {
    const { modelHandler, latexMediaManager, config, fileService } =
      this.services;

    if (
      !modelHandler.capabilities.supportsVision ||
      prepRes.files.length === 0
    ) {
      return null;
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
      // Output files live at `runDir/r{round}/…`; mirror mirrored-workspace
      // deps (cls/sty/bib, local \input targets) as symlinks inside the
      // round dir so pdflatex/latexmk can resolve them during auto-compile.
      await fileService.ensureMirroredInRoundDir(prepRes.currentRound);
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
