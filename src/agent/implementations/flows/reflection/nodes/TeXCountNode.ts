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

interface TeXCountPrepInput {
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

  async prep(shared: ReflectionFlowShared): Promise<TeXCountPrepInput> {
    const { config, fileService } = this.services;
    const { currentRound, roundOutputs, context } = shared;

    return {
      files: getFilesForRound(currentRound, roundOutputs, config, fileService),
      attachTeXCount: config.toolConfig.attachTeXCount,
      context,
    };
  }

  async exec(prepRes: TeXCountPrepInput): Promise<string | null> {
    if (!prepRes.attachTeXCount || prepRes.files.length === 0) {
      return null;
    }
    return getTeXCountStats(prepRes.files.map((f) => f.absolutePath));
  }

  async execFallback(): Promise<string | null> {
    return null;
  }

  async post(
    shared: ReflectionFlowShared,
    _prepRes: TeXCountPrepInput,
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
