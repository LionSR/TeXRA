import { z } from 'zod';

import { StreamTabIdSchema } from '@shared/schemas/identifiers';
import { PlanSchema } from '@shared/schemas/plan';

export const ODYSSEY_TOOL_NAME = 'odyssey' as const;

export const ODYSSEY_FEATURE_FLAG_KEY =
  'texra.experimental.odyssey.enabled' as const;

/** Cap on the history-event ring buffer per Odyssey record (oldest dropped). */
export const ODYSSEY_HISTORY_LIMIT = 200;

/**
 * Default maximum continuations before the Odyssey auto-pauses for user
 * confirmation. Acts as a safety net so a model that never calls
 * `odyssey(complete)` doesn't loop forever.
 */
export const ODYSSEY_DEFAULT_MAX_CONTINUATIONS = 50;

export const OdysseyStatusSchema = z.enum([
  'active',
  'paused',
  'complete',
  'abandoned',
]);
export type OdysseyStatus = z.infer<typeof OdysseyStatusSchema>;

export function isOdysseyInFlight(
  odyssey: { status: OdysseyStatus } | null | undefined,
): boolean {
  return odyssey?.status === 'active' || odyssey?.status === 'paused';
}

export const OdysseyEventKindSchema = z.enum([
  'started',
  'paused',
  'resumed',
  'objective_edited',
  'completed',
  'abandoned',
  'continuation_injected',
  'continuation_cap_reached',
]);
export type OdysseyEventKind = z.infer<typeof OdysseyEventKindSchema>;

export const OdysseyEventSchema = z.object({
  at: z.iso.datetime(),
  kind: OdysseyEventKindSchema,
  detail: z.string().nullish(),
});
export type OdysseyEvent = z.infer<typeof OdysseyEventSchema>;

export const OdysseySchema = z.object({
  odysseyId: z.string().min(1),
  streamId: StreamTabIdSchema,
  objective: z.string().min(1),
  status: OdysseyStatusSchema,
  /** Continuations injected since the last resume / start. */
  continuationCount: z.int().nonnegative().prefault(0),
  /** Cap before auto-pause. Reset on resume so each leg gets a fresh budget. */
  maxContinuations: z
    .int()
    .positive()
    .prefault(ODYSSEY_DEFAULT_MAX_CONTINUATIONS),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedReason: z.string().nullish(),
  history: z.array(OdysseyEventSchema).default([]),
  /**
   * Structured plan that seeded the odyssey, when it was started from a
   * Plan-tool approval. Pure metadata for UI / inspection — the
   * continuation prompt still uses `objective` as the canonical instruction.
   */
  plan: PlanSchema.nullish(),
});

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
export type Odyssey = z.infer<typeof OdysseySchema>;

/** Top-level command names exposed by the OdysseyTool. */
export const OdysseyCommandSchema = z.enum([
  'view',
  'start',
  'pause',
  'complete',
]);
export type OdysseyCommand = z.infer<typeof OdysseyCommandSchema>;

export const OdysseyToolInputSchema = z.strictObject({
  command: OdysseyCommandSchema,
  objective: z
    .string()
    .nullish()
    .describe(
      'Required for command="start". Phrase as "Complete X until Y holds" ' +
        'with a verifiable stopping condition.',
    ),
  reason: z
    .string()
    .nullish()
    .describe(
      'Required for command="pause" and command="complete". ' +
        'For "pause": describe what you need from the user. ' +
        'For "complete": describe HOW you verified the objective is met ' +
        '(cite current filesystem state, test output, or command results — ' +
        'never conversation memory).',
    ),
});
export type OdysseyToolInput = z.infer<typeof OdysseyToolInputSchema>;
