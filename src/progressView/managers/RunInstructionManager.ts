// Local imports - progress view persistence
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';

// Local imports - identifiers and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - types
import type { InstructionUpdate } from '@progressView/types';

type InstructionMap = Map<string, InstructionUpdate>;

/**
 * Persists run-scoped instruction updates per stream.
 */
export class RunInstructionManager extends PersistentMapManager<
  StreamTabId,
  InstructionMap
> {
  private readonly logger: AgentLogger;

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.RUN_INSTRUCTIONS, storage);
    this.logger = new AgentLogger('RunInstructionManager');
  }

  getInstructions(stream: StreamTabId): InstructionMap {
    return new Map(this.get(stream) ?? []);
  }

  async setInstruction(
    stream: StreamTabId,
    runId: string,
    instruction: InstructionUpdate | null,
  ): Promise<void> {
    if (!runId) {
      return;
    }

    const existing = this.items.get(stream) ?? new Map();

    if (!instruction) {
      existing.delete(runId);
    } else {
      existing.set(runId, instruction);
    }

    if (existing.size === 0) {
      this.items.delete(stream);
    } else {
      this.items.set(stream, existing);
    }

    await this.save();
  }

  async deleteRun(stream: StreamTabId, runId: string): Promise<void> {
    if (!runId) {
      return;
    }

    const existing = this.items.get(stream);
    if (!existing) {
      return;
    }

    existing.delete(runId);
    if (existing.size === 0) {
      this.items.delete(stream);
    }

    await this.save();
  }

  async clearStream(stream: StreamTabId): Promise<void> {
    if (!this.items.delete(stream)) {
      return;
    }

    await this.save();
  }

  protected override serialize(
    value: InstructionMap,
    _key: StreamTabId,
  ): unknown {
    return Object.fromEntries(value.entries());
  }

  protected override async deserialize(
    data: unknown,
    stream: StreamTabId,
  ): Promise<InstructionMap> {
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    try {
      const entries = Object.entries(data as Record<string, InstructionUpdate>);
      return new Map(entries as [string, InstructionUpdate][]);
    } catch (error) {
      this.logger.warn(
        `Failed to deserialize run instructions for ${stream}: ${String(error)}`,
      );
      return new Map();
    }
  }
}
