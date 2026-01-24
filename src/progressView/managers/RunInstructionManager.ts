// Local imports - identifiers and logging
import type { StorageKey, StreamTabId } from '@shared/schemas';

// Internal imports
import { WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - types
import type { InstructionUpdate } from '@progressView/types';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import {
  mapToRecord,
  recordToMap,
} from '@progressView/persistence/serializationUtils';

type InstructionMap = Map<string, InstructionUpdate>;

/**
 * Persists run-scoped instruction updates per stream.
 */
export class RunInstructionManager extends PersistentMapManager<
  StreamTabId,
  InstructionMap
> {
  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.RUN_INSTRUCTIONS, storage);
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

    this.setOrDeleteIfEmpty(stream, existing);
    await this.save();
  }

  async deleteRun(stream: StreamTabId, storageKey: StorageKey): Promise<void> {
    const existing = this.items.get(stream);
    if (!existing) {
      return;
    }

    existing.delete(storageKey);
    this.setOrDeleteIfEmpty(stream, existing);
    await this.save();
  }

  /** Sets the map if non-empty, otherwise deletes the stream entry */
  private setOrDeleteIfEmpty(stream: StreamTabId, map: InstructionMap): void {
    if (map.size === 0) {
      this.items.delete(stream);
    } else {
      this.items.set(stream, map);
    }
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

  protected override deserialize(
    data: unknown,
    _stream: StreamTabId,
  ): InstructionMap {
    return recordToMap<InstructionUpdate>(data);
  }
}
