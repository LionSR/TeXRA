/**
 * Generic per-stream bypass state manager.
 *
 * Extracted from the identical pattern in toolEditApproval and
 * proposalApproval to eliminate state management duplication.
 */
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';

type EmitPayload = Record<string, unknown>;

export class BypassStateManager {
  private readonly bypassedByStream = new Map<StreamTabId, boolean>();
  private readonly eventName: string;
  private readonly buildPayload: (
    streamId: StreamTabId,
    bypassActive: boolean,
  ) => EmitPayload;

  constructor(
    eventName: string,
    buildPayload?: (
      streamId: StreamTabId,
      bypassActive: boolean,
    ) => EmitPayload,
  ) {
    this.eventName = eventName;
    this.buildPayload =
      buildPayload ??
      ((streamId, bypassActive) => ({ streamId, bypassActive }));
  }

  private notify(streamId: StreamTabId): void {
    const bypassActive = this.bypassedByStream.get(streamId) ?? false;
    bus.emit(
      this.eventName as Parameters<typeof bus.emit>[0],
      this.buildPayload(streamId, bypassActive) as never,
    );
  }

  /** Set bypass state explicitly. */
  set(streamId: StreamTabId, enabled: boolean): void {
    this.bypassedByStream.set(streamId, enabled);
    this.notify(streamId);
  }

  /** Toggle bypass state. Returns new state. */
  toggle(streamId: StreamTabId): boolean {
    const newState = !(this.bypassedByStream.get(streamId) ?? false);
    this.set(streamId, newState);
    return newState;
  }

  /** Check if bypass is active for a stream. */
  isActive(streamId: StreamTabId): boolean {
    return this.bypassedByStream.get(streamId) ?? false;
  }

  /** Clear bypass for a specific stream. */
  clearForStream(streamId: StreamTabId): void {
    this.bypassedByStream.delete(streamId);
  }

  /** Clear all bypass states. */
  clearAll(): void {
    this.bypassedByStream.clear();
  }

  /** Clear all and notify each previously-active stream. Returns affected stream IDs. */
  disableAllAndNotify(): StreamTabId[] {
    const affected: StreamTabId[] = [];
    for (const [id, active] of this.bypassedByStream) {
      if (active) affected.push(id);
    }
    this.bypassedByStream.clear();
    for (const streamId of affected) {
      this.notify(streamId);
    }
    return affected;
  }
}
