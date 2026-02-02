/**
 * TeXCountNode - Computes TeXCount statistics and adds to messages.
 */

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { FileLocation } from '@utils/files';
import { getTeXCountStats } from '@latex';

import { getFilesForRound } from '../helpers';
import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

/**
 * Prep result carries shared reference and computed files.
 * Files are computed once in prep() to avoid redundant calls.
 */
interface PrepInput {
  shared: ReflectionFlowShared;
  files: FileLocation[];
}

export class TeXCountNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<PrepInput> {
    const { config, fileService } = this.services;
    return {
      shared,
      files: getFilesForRound(
        shared.currentRound,
        shared.roundOutputs,
        config,
        fileService,
      ),
    };
  }

  async exec(prepRes: PrepInput): Promise<string | null> {
    const { config } = this.services;
    if (!config.toolConfig.attachTeXCount || prepRes.files.length === 0) {
      return null;
    }
    return getTeXCountStats(prepRes.files.map((f) => f.absolutePath));
  }

  async execFallback(
    _prepRes: PrepInput,
    error: Error,
  ): Promise<string | null> {
    const { logger } = this.services;
    logger.debug(`TeXCount skipped: ${error.message}`);
    return null;
  }

  async post(
    _shared: ReflectionFlowShared,
    prepRes: PrepInput,
    execRes: string | null,
  ): Promise<string | undefined> {
    if (execRes && prepRes.shared.context) {
      this.services.modelHandler.prependTextToUserMessage(
        prepRes.shared.context.messages,
        execRes,
      );
    }
    return FlowTransition.DEFAULT;
  }
}
