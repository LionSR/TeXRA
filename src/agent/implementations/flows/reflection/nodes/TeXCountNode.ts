/**
 * TeXCountNode - Computes TeXCount statistics and adds to messages.
 */

// Local imports - agent
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { Node } from '@agent/node';

// Local imports - shared schemas
import type { FileLocation } from '@shared/schemas';

// Local imports - latex
import { getTeXCountStats } from '@latex';

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
  attachTeXCount: boolean;
  context: RoundContext | null;
}

export class TeXCountNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
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
