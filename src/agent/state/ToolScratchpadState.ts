// Local imports - logging
import * as logger from '@logger/logUtils';

const CHANNEL = 'ToolScratchpadState';
logger.initialize(CHANNEL);

export interface ToolScratchpadSnapshot {
  texcountStats: string | null;
  lastResponse: string;
  accumulatedOutput: string;
}

/**
 * Stores tool-related scratchpad text, including the latest model response,
 * accumulated output, and texcount metadata. This state is isolated so the
 * scratchpad can evolve independently of media attachments or reasoning traces.
 */
export class ToolScratchpadState {
  private state: ToolScratchpadSnapshot;

  constructor(snapshot?: Partial<ToolScratchpadSnapshot>) {
    this.state = {
      texcountStats: null,
      lastResponse: '',
      accumulatedOutput: '',
      ...snapshot,
    };
  }

  get texcountStats(): string | null {
    return this.state.texcountStats;
  }

  set texcountStats(value: string | null) {
    this.state.texcountStats = value;
  }

  get lastResponse(): string {
    return this.state.lastResponse;
  }

  get accumulatedOutput(): string {
    return this.state.accumulatedOutput;
  }

  updateLastResponse(response: string): void {
    this.state.lastResponse = response;
  }

  updateAccumulatedOutput(output: string): void {
    this.state.accumulatedOutput = output;
  }

  toSnapshot(): ToolScratchpadSnapshot {
    return { ...this.state };
  }

  static fromSnapshot(snapshot: ToolScratchpadSnapshot): ToolScratchpadState {
    return new ToolScratchpadState(snapshot);
  }
}
