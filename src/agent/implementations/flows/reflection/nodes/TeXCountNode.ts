/**
 * TeXCountNode - Computes TeXCount statistics and adds to messages.
 */

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import type { FileLocation } from '@utils/files';
import { getTeXCountStats } from '@latex';

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
  attachTeXCount: boolean;
  context: RoundContext | null;
}

export class TeXCountNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(shared: ReflectionFlowShared): Promise<PrepInput> {
    const { config, fileService } = this.services;
    return {
      files: getFilesForRound(
        shared.currentRound,
        shared.roundOutputs,
        config,
        fileService,
      ),
      attachTeXCount: config.toolConfig.attachTeXCount,
      context: shared.context,
    };
  }

  async exec(prepRes: PrepInput): Promise<string | null> {
    // Check interruption before expensive operation for responsive cancellation
    if (this.services.checkInterruption()) {
      return null;
    }
    if (!prepRes.attachTeXCount || prepRes.files.length === 0) {
      return null;
    }
    return getTeXCountStats(prepRes.files.map((f) => f.absolutePath));
  }

  async execFallback(
    _prepRes: PrepInput,
    error: Error,
  ): Promise<string | null> {
    this.services.logger.debug(`TeXCount skipped: ${error.message}`);
    return null;
  }

  async post(
    shared: ReflectionFlowShared,
    _prepRes: PrepInput,
    execRes: string | null,
  ): Promise<string | undefined> {
    if (execRes && shared.context) {
      this.services.modelHandler.prependTextToUserMessage(
        shared.context.messages,
        execRes,
      );
    }
    return FlowTransition.DEFAULT;
  }
}
