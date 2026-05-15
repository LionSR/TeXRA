import type { StreamTabId } from '@shared/schemas/identifiers';

import { OdysseyStore } from '@tools/odyssey';

export interface OdysseyTurnAccounting {
  /** Total tokens consumed during this turn (input + output). */
  tokens: number;
}

/**
 * Accumulate per-turn token usage on the current odyssey. No-op when
 * there is no Odyssey on the stream or when the record is in a terminal
 * state (complete / abandoned). Wall-clock elapsed time is computed live
 * from `Odyssey.createdAt` — no per-turn accumulation needed.
 *
 * Safe to call unconditionally from the tool-use cycle's progress sink —
 * the store handles missing records.
 */
export async function applyTurnAccounting(
  streamId: StreamTabId,
  accounting: OdysseyTurnAccounting,
): Promise<void> {
  const odyssey = OdysseyStore.getForStream(streamId);
  if (!odyssey) return;
  if (odyssey.status !== 'active' && odyssey.status !== 'paused') return;
  await OdysseyStore.addUsage(streamId, accounting.tokens);
}
