import {
  InstructionUpdateSchema,
  type InstructionUpdate,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@common/state/stateManager';
import {
  PersistentMapManager,
  type MementoStorage,
} from '@progressView/persistence/PersistentMapManager';
import { createRecordToMapSchema } from '@progressView/persistence/schemaUtils';
import { mapToRecord } from '@progressView/persistence/serializationUtils';

/** Schema for deserializing persisted instructions */
const InstructionsMapSchema = createRecordToMapSchema(InstructionUpdateSchema);

type InstructionMap = Map<string, InstructionUpdate>;

/**
 * Persists run-scoped instruction updates per stream.
 */
export class RunInstructionManager extends PersistentMapManager<
  StreamTabId,
  InstructionMap
> {
  constructor(storage?: MementoStorage) {
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
    const existing = this.getOrCreate(stream, () => new Map());

    if (instruction) {
      existing.set(storageKey, instruction);
    } else {
      existing.delete(storageKey);
    }

    // Clean up empty map
    if (existing.size === 0) {
      this.items.delete(stream);
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

  protected override deserialize(
    data: unknown,
    _key: StreamTabId,
  ): InstructionMap {
    return InstructionsMapSchema.parse(data);
  }
}
