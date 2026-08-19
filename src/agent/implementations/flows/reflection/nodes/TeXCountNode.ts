import { BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { getTeXCountStats } from '@latex/texcount';
import type { FileLocation } from '@shared/schemas';

import { getFilesForRound } from '../helpers';
import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type { ReflectionServices } from '../ReflectionServices';

export class TeXCountNode<C = unknown> extends BaseNode<
  ReflectionFlowShared,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<FileLocation[]> {
    const { config, fileService } = this.services;
    return getFilesForRound(
      shared.currentRound,
      shared.roundOutputs,
      config,
      fileService,
    );
  }

  async exec(files: FileLocation[]): Promise<string | null> {
    const { config } = this.services;
    if (!config.toolConfig.attachTeXCount || files.length === 0) {
      return null;
    }
    return getTeXCountStats(files.map((f) => f.absolutePath));
  }

  async execFallback(
    _files: FileLocation[],
    error: Error,
  ): Promise<string | null> {
    const { logger } = this.services;
    logger.debug('TeXCount skipped', { data: error });
    return null;
  }

  async post(
    shared: ReflectionFlowShared,
    _files: FileLocation[],
    execRes: string | null,
  ): Promise<string | undefined> {
    if (execRes && shared.context) {
      this.services.modelCell.handler.prependTextToUserMessage(
        shared.context.messages,
        execRes,
      );
    }
    return FlowTransition.DEFAULT;
  }
}
