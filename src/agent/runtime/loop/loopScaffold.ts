/**
 * Scaffolding both run programs (`toolUse.ts`, `reflection.ts`) share around
 * the shared engine (the invoker, the dispatch unit, `runExit.ts`). These are
 * the small pieces that would otherwise be copied byte-for-byte into each loop
 * and silently drift: the refusal a fresh launch onto an opened aggregate
 * gives, and the round's priced-usage record that must be charged against the
 * binding that actually served it.
 */

import { Effect, SynchronizedRef } from 'effect';

import type { RunId, AgentRunStateSnapshot } from '@shared/schemas';

import type { AgentRunShape } from '../run/AgentRun';

/**
 * Why a fresh launch onto an aggregate that already holds ledger state is
 * refused (#11313). Both run programs fail their opening with it, so the
 * message stays one string the two families cannot diverge on.
 */
export const alreadyOpenedMessage = (runId: RunId): string =>
  `Run ${runId} already has ledger state; resume it instead.`;

/**
 * Record one round's usage against the binding that served it. A manual retry
 * may have rebound the model inside the invoker, so the price is charged
 * against `run.model`'s current value rather than whatever the round started
 * with. Both loops call this after a successful round.
 */
export const recordServedUsage = (
  run: Pick<AgentRunShape, 'model' | 'usageMonitor'>,
  snapshot: AgentRunStateSnapshot,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const served = yield* SynchronizedRef.get(run.model);
    yield* Effect.sync(() => run.usageMonitor.recordUsage(snapshot, served));
  });
