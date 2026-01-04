// Local imports - identifiers and logging
import type { StorageKey, StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - types
import type { InstructionUpdate } from '@progressView/types';

// Internal imports
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import { mapToRecord } from '@progressView/persistence/serializationUtils';

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
    storageKey: StorageKey,
    instruction: InstructionUpdate | null,
  ): Promise<void> {
    const existing = this.items.get(stream) ?? new Map();

    if (!instruction) {
      existing.delete(storageKey);
    } else {
      existing.set(storageKey, instruction);
    }

    if (existing.size === 0) {
      this.items.delete(stream);
    } else {
      this.items.set(stream, existing);
    }

    await this.save();
  }

  async deleteRun(stream: StreamTabId, storageKey: StorageKey): Promise<void> {
    const existing = this.items.get(stream);
    if (!existing) {
      return;
    }

    existing.delete(storageKey);
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
    return mapToRecord(value);
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
