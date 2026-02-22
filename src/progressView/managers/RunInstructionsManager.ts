import type {
  InstructionUpdate,
  StorageKey,
  StreamTabId,
} from '@shared/schemas';
import { AgentLogger } from '@logger/AgentLogger';
import { mapToRecord } from '@progressView/persistence/serializationUtils';
import { getStreamTabStore } from '@progressView/persistence/StreamTabStore';

/**
 * Manages per-stream run instructions with disk-backed persistence.
 *
 * Disk writes happen per-stream on mutation. Disk deletion is owned by
 * ProgressViewState (via store.clear() / deleteAllStreamData()).
 */
export class RunInstructionsManager {
  private items = new Map<StreamTabId, Map<string, InstructionUpdate>>();
  private loaded = false;
  private readonly logger: AgentLogger;

  constructor() {
    this.logger = new AgentLogger('RunInstructionsManager');
  }

  /** Get all instructions for a stream (returns a copy). */
  getAll(stream: StreamTabId): Map<string, InstructionUpdate> {
    return new Map(this.items.get(stream) ?? []);
  }

  /** Get instruction for a specific run. */
  get(stream: StreamTabId, runId: StorageKey): InstructionUpdate | undefined {
    return this.items.get(stream)?.get(runId);
  }

  /** Set or delete an instruction for a specific run. */
  set(
    stream: StreamTabId,
    runId: StorageKey,
    instruction: InstructionUpdate | null,
  ): void {
    const existing = this.items.get(stream) ?? new Map();

    if (instruction) {
      existing.set(runId, instruction);
      this.items.set(stream, existing);
    } else {
      existing.delete(runId);
      if (existing.size === 0) {
        this.items.delete(stream);
      }
    }

    this.save(stream);
  }

  /** Remove a stream from in-memory state. Disk cleanup owned by caller. */
  evict(stream: StreamTabId): void {
    this.items.delete(stream);
  }

  /** Clear all in-memory state. Disk cleanup owned by caller. */
  evictAll(): void {
    this.items.clear();
  }

  /** Load run instructions from disk-backed StreamTabStore. */
  async load(streamIds: StreamTabId[]): Promise<void> {
    this.items.clear();

    await Promise.all(
      streamIds.map(async (streamId) => {
        const store = getStreamTabStore(streamId);
        const runInstructions = await store.readRunInstructions();
        if (runInstructions && runInstructions.size > 0) {
          this.items.set(streamId, runInstructions);
        }
      }),
    );

    this.loaded = true;

    if (this.items.size > 0) {
      this.logger.debug(
        `Loaded run instructions for ${this.items.size} streams`,
      );
    }
  }

  // -- Per-stream persistence -------------------------------------------------

  private save(stream: StreamTabId): void {
    if (!this.loaded) return;
    const data = this.items.get(stream);
    const store = getStreamTabStore(stream);
    void store.writeRunInstructions(
      data && data.size > 0 ? mapToRecord(data) : {},
    );
  }
}
