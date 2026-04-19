import { AgentLogger } from '@logger/AgentLogger';
import { getStreamTabStore } from '@progressView/persistence/StreamTabStore';
import type { InstructionUpdate, StreamTabId } from '@shared/schemas';

/**
 * Manages per-stream instruction with disk-backed persistence.
 *
 * One instruction per stream tab — each workflow tab is a single run, so
 * instructions don't need a run dimension.
 *
 * Disk writes happen per-stream on mutation. Disk deletion is owned by
 * ProgressViewState (via store.clear() / deleteAllStreamData()).
 */
export class InstructionManager {
  private items = new Map<StreamTabId, InstructionUpdate>();
  private loaded = false;
  private readonly logger: AgentLogger;
  private readonly pendingWrites = new Map<StreamTabId, Promise<void>>();

  constructor() {
    this.logger = new AgentLogger('InstructionManager');
  }

  /** Get the instruction for a stream. */
  get(stream: StreamTabId): InstructionUpdate | undefined {
    return this.items.get(stream);
  }

  /** Set or clear the instruction for a stream. */
  set(stream: StreamTabId, instruction: InstructionUpdate | null): void {
    if (instruction) {
      this.items.set(stream, instruction);
    } else {
      this.items.delete(stream);
    }
    this.save(stream);
  }

  /** Remove a stream from in-memory state. Disk cleanup owned by caller. */
  evict(stream: StreamTabId): void {
    this.items.delete(stream);
    this.pendingWrites.delete(stream);
  }

  /** Clear all in-memory state. Disk cleanup owned by caller. */
  evictAll(): void {
    this.items.clear();
    this.pendingWrites.clear();
  }

  /** Load instruction from disk-backed StreamTabStore. */
  async load(streamIds: StreamTabId[]): Promise<void> {
    this.items.clear();

    await Promise.all(
      streamIds.map(async (streamId) => {
        const store = getStreamTabStore(streamId);
        const instruction = await store.readInstruction();
        if (instruction) {
          this.items.set(streamId, instruction);
        }
      }),
    );

    this.loaded = true;

    if (this.items.size > 0) {
      this.logger.debug(
        `Loaded instructions for ${this.items.size} streams`,
      );
    }
  }

  /** Await all pending disk writes. */
  async flush(): Promise<void> {
    await Promise.all(this.pendingWrites.values());
  }

  // -- Per-stream persistence -------------------------------------------------

  private save(stream: StreamTabId): void {
    if (!this.loaded) return;
    const prev = this.pendingWrites.get(stream) ?? Promise.resolve();
    const next = prev.then(() => {
      if (!this.pendingWrites.has(stream)) return;
      const data = this.items.get(stream);
      const store = getStreamTabStore(stream);
      return store.writeInstruction(data ?? null);
    });
    this.pendingWrites.set(
      stream,
      next.catch(() => {}),
    );
  }
}

// Back-compat re-export (renamed class) — kept so existing imports stay stable
// until all references are updated.
export { InstructionManager as RunInstructionsManager };
