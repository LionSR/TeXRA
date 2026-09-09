import { Effect } from 'effect';

import { BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { getTeXCountStats } from '@latex/texcount';
import { effectRuntime } from '@platform/processRuntime';
import type { FileLocation } from '@shared/schemas';

import { getFilesForRound } from '../helpers';
import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type { ReflectionServices } from '../ReflectionServices';

export class TeXCountNode extends BaseNode<
  ReflectionFlowShared,
  ReflectionServices
> {
  override async prep(shared: ReflectionFlowShared): Promise<FileLocation[]> {
    const { config, fileService } = this.services;
    return getFilesForRound(
      shared.currentRound,
      shared.roundOutputs,
      config,
      fileService,
    );
  }

  override async exec(files: FileLocation[]): Promise<string | null> {
    const { config } = this.services;
    if (!config.toolConfig.attachTeXCount || files.length === 0) {
      return null;
    }
    // The one Promise seam left in this node: texcount is Effect below this
    // line and the flow engine above it is not. The run goes when the
    // reflection flow itself becomes a plain Effect loop (PRD R4).
    return effectRuntime().runPromise(
      getTeXCountStats(files.map((f) => f.absolutePath)),
    );
  }

  override async execFallback(
    _files: FileLocation[],
    error: Error,
  ): Promise<string | null> {
    const { logger } = this.services;
    logger.debug('TeXCount skipped', { data: error });
    return null;
  }

  override async post(
    shared: ReflectionFlowShared,
    _files: FileLocation[],
    execRes: string | null,
  ): Promise<string | undefined> {
    if (execRes && shared.context) {
      this.services.modelCell.handler.prependTextToUserMessage(
        shared.context,
        execRes,
      );
    }
    return FlowTransition.DEFAULT;
  }
}
