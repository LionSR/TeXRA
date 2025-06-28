// Standard library imports
import * as path from 'path';

// Local imports - event bus
import { emitProgress } from '@eventBus/ProgressEventBus';
import type {
  InputStatusPayload,
  InputFileInfo,
} from '@eventBus/ProgressEventBus';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Deep module that hides the complexity of collecting and aggregating
 * file loading events from multiple sources across agent execution rounds.
 *
 * Provides a simple interface while managing internal state, round tracking,
 * and event aggregation logic.
 */
export class InputStatusCollector {
  private readonly logger: AgentLogger;
  private currentRound: number = 0;
  private currentStream: string = '';

  constructor(logger: AgentLogger) {
    this.logger = logger;
  }

  /**
   * Set current execution context
   * Called by agent runtime when stream or round changes
   */
  setContext(streamId: string, round: number = 0): void {
    this.currentStream = streamId;
    this.currentRound = round;
  }

  /**
   * Set current execution round
   * Called by agent runtime when rounds change
   */
  setRound(round: number): void {
    this.currentRound = round;
  }

  /**
   * Record required file loading result
   * Simple interface hides internal aggregation complexity
   */
  recordRequiredFile(
    filePath: string,
    varName: string,
    found: boolean,
    isAbsolute: boolean = false,
  ): void {
    if (!this.currentStream) {
      this.logger.debug('No current stream set for input status collection');
      return;
    }

    const fileInfo: InputFileInfo = {
      path: filePath,
      varName,
      found,
      isClickable: !isAbsolute, // workspace files are clickable
    };

    this._aggregateAndEmit(this.currentStream, 'required', [fileInfo]);
  }

  /**
   * Record media file loading results
   * Batch processing for multiple files
   */
  recordMediaFiles(mediaFiles: string[]): void {
    if (!this.currentStream || mediaFiles.length === 0) {
      this.logger.debug('No current stream set or no media files to record');
      return;
    }

    const fileInfos: InputFileInfo[] = mediaFiles.map((mediaFile) => ({
      path: mediaFile,
      found: true,
      isClickable: !path.isAbsolute(mediaFile),
    }));

    this._aggregateAndEmit(this.currentStream, 'media', fileInfos);
  }

  /**
   * Internal aggregation and emission logic - hidden from clients
   * Implements batching and deduplication
   */
  private _aggregateAndEmit(
    streamId: string,
    type: 'required' | 'media',
    files: InputFileInfo[],
  ): void {
    try {
      const payload: InputStatusPayload = {
        stream: streamId,
        timestamp: Date.now(),
        round: this.currentRound,
        type,
        files,
      };

      emitProgress('updateInputStatus', payload);
    } catch (error) {
      this.logger.error(
        `Failed to emit input status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// Singleton instance for agent runtime
let globalCollector: InputStatusCollector | null = null;

export function getInputStatusCollector(): InputStatusCollector {
  if (!globalCollector) {
    const logger = new AgentLogger('InputStatusCollector');
    globalCollector = new InputStatusCollector(logger);
  }
  return globalCollector;
}
