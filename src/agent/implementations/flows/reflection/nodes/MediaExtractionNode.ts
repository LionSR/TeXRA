import { Node } from '@agent/node';
import { logUserMessage } from '@agent/trace';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { FileLocation, MediaAttachmentKind } from '@shared/schemas';

import { getFilesForRound, workspaceFromSnapshot } from '../helpers';
import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type { ReflectionServices } from '../ReflectionServices';

interface PrepInput {
  files: FileLocation[];
  extraMediaFiles: FileLocation[];
  workspaceState: AgentWorkspaceState;
  currentRound: number;
}

export class MediaExtractionNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<PrepInput> {
    const { config, fileService } = this.services;
    const modelHandler = this.services.modelCell.handler;
    const { currentRound, roundOutputs } = shared;

    const workspaceState = workspaceFromSnapshot(shared.workspaceSnapshot);

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
    const modelHandler = this.services.modelCell.handler;
    const { latexMediaManager, config, fileService } = this.services;

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
      );
    }

    // The workspace owns its media list (read-only, deduplicated on write),
    // so the round hands the model handler its own snapshot of it.
    return [...prepRes.workspaceState.media.files];
  }

  async execFallback(
    _prepRes: PrepInput,
    error: Error,
  ): Promise<FileLocation[] | null> {
    const { logger } = this.services;
    logger.debug('Media extraction skipped', { data: error });
    return null;
  }

  async post(
    shared: ReflectionFlowShared,
    prepRes: PrepInput,
    mediaFiles: FileLocation[] | null,
  ): Promise<string | undefined> {
    shared.workspaceSnapshot = prepRes.workspaceState.toSnapshot();

    // The transcript's opening row must be logged whether addMediaToUserMessage
    // succeeds or throws (e.g. a corrupt/oversized media file) -- otherwise a
    // failed first turn leaves no record of what the user asked for. `finally`
    // preserves the throw so the run still fails as before; a throw before any
    // attachment was inserted just yields an empty attachments list, which is
    // accurate (nothing was actually inserted).
    let attachmentKinds: MediaAttachmentKind[] = [];
    try {
      if (mediaFiles?.length && shared.context) {
        attachmentKinds =
          await this.services.modelCell.handler.addMediaToUserMessage(
            shared.context.messages,
            mediaFiles,
          );
      }
    } finally {
      if (
        prepRes.currentRound === 0 &&
        this.services.initialUserMessageForTranscript
      ) {
        logUserMessage(
          this.services.logger,
          this.services.initialUserMessageForTranscript,
          attachmentKinds,
        );
      }
    }

    return FlowTransition.DEFAULT;
  }
}
