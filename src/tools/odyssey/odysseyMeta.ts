import { z } from 'zod';

import { StreamTabIdSchema } from '@shared/schemas/identifiers';
import { PlanSchema } from '@shared/schemas/plan';

export const ODYSSEY_FEATURE_FLAG_KEY = 'texra.odyssey.enabled' as const;

/**
 * Pre-graduation key. Odyssey shipped experimental and OFF by default; it
 * graduated to a first-class, on-by-default mode in June 2026. This legacy
 * key is still honored for back-compat when a user explicitly set it — see
 * `isOdysseyEnabled()` in `odysseyFeatureFlag.ts`.
 */
export const LEGACY_ODYSSEY_FEATURE_FLAG_KEY =
  'texra.experimental.odyssey.enabled' as const;

/**
 * An odyssey is a live pursuit: it exists only while the autonomous loop is
 * running (`active`) or waiting for the user (`paused`). Finishing or
 * abandoning one drops the record entirely (`OdysseyStore.forget`) rather than
 * parking it in a terminal state — there is no audit log to preserve.
 */
export const OdysseyStatusSchema = z.enum(['active', 'paused']);
export type OdysseyStatus = z.infer<typeof OdysseyStatusSchema>;

/**
 * True when a record exists for the stream. With only `active`/`paused` as
 * persisted states, any record is an in-flight pursuit; complete/abandon
 * forget the record instead of transitioning it.
 */
export function isOdysseyInFlight(
  odyssey: { status: OdysseyStatus } | null | undefined,
): boolean {
  return odyssey != null;
}

export const OdysseySchema = z.object({
  odysseyId: z.string().min(1),
  streamId: StreamTabIdSchema,
  objective: z.string().min(1),
  status: OdysseyStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * Structured plan that seeded the odyssey, when it was started from a
   * Plan-tool approval. Pure metadata for UI / inspection — the
   * continuation prompt still uses `objective` as the canonical instruction.
   */
  plan: PlanSchema.nullish(),
});
export type Odyssey = z.infer<typeof OdysseySchema>;

/**
 * Wall-clock elapsed time since the odyssey was started.
 * Computed live so we don't need to accumulate ticks (which would either
 * be wrong while paused or wrong while idle between turns).
 */
export function odysseyElapsedMs(odyssey: { createdAt: string }): number {
  return Math.max(0, Date.now() - new Date(odyssey.createdAt).getTime());
}

export function odysseyDurationMs(odyssey: {
  status: OdysseyStatus;
  createdAt: string;
  updatedAt: string;
}): number {
  const start = new Date(odyssey.createdAt).getTime();
  const end = isOdysseyInFlight(odyssey)
    ? Date.now()
    : new Date(odyssey.updatedAt).getTime();
  return Math.max(0, end - start);
}

/**
 * Hour-aware duration formatter for Odyssey timings. Lives here (not in
 * `@utils/core/stringCore`) so it's importable from webview frontends via
 * `@shared/schemas`, keeping the tool view and the settings tab in sync.
 */
export function formatOdysseyTime(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hours > 0) return `${hours}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}
