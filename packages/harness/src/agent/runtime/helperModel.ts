/**
 * The helper model: one "helper model" setting behind session descriptions
 * and draft polishing, else the asking run's own model. Every use is one
 * non-streaming turn, text in, text out, on a binding `ModelAccess` makes for
 * the helper.
 *
 * A helper call is gated, priced and reported to the usage log like every
 * model call; it writes no run history row, because it belongs to no run's history.
 */
import { Effect, ScopedRef, type Scope } from 'effect';

import type { CallFailure } from '@agent/runtime/modelAccess/failureInfo';
import {
  modelAccessLayer,
  ModelAccess,
} from '@agent/runtime/modelAccess/ModelAccess';
import type { Secrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settings';
import type { NormalizedUsage } from '@shared/schemas';
import { turnText } from '@shared/session/runFacts';
import type { UsageLog } from '@shared/usageLog';

import { callModel } from './run/modelCall';
import type { RouteRetries } from './run/invocation';
import type { UsageAttribution } from './run/pricing';
import type { HttpClient } from 'effect/http';

/** A single non-streaming helper-model text completion. */
export interface HelperPrompt {
  /** User message content. */
  readonly userPrompt: string;
  /** Optional system prompt. */
  readonly systemPrompt?: string;
}

/**
 * One helper call: bind the configured helper model (else `runModel`) for
 * this call alone and run one completion through the one retry loop
 * (`run/invocation.ts`), gated on the process's retry gate, priced and
 * reported to the usage log as `attribution`. No row is written. Returns the
 * turn's assistant text and its priced usage (`null`: the provider reported
 * none), for a caller whose row records what the call cost. `stores` are the
 * asking session's setting slots: the binding, the retry limit and the usage
 * consent read them, beside the process `Secrets`.
 */
export const helperCall = Effect.fn('helperCall')(
  function* (
    stores: SettingsStores,
    { userPrompt, systemPrompt }: HelperPrompt,
    attribution: UsageAttribution,
    {
      retries,
      runModel,
    }: {
      /** Automatic retries; the configured batch when absent. */
      readonly retries?: number;
      /** The asking run's model, used when no helper model is configured;
       *  with neither, the call fails as unavailable. */
      readonly runModel?: string;
    } = {},
  ): Effect.fn.Return<
    { readonly text: string; readonly usage: NormalizedUsage | null },
    CallFailure | Error,
    Scope.Scope | HttpClient.HttpClient | UsageLog | RouteRetries | Secrets
  > {
    const access = yield* Effect.provide(ModelAccess, modelAccessLayer(stores));
    // ScopedRef masks its acquisition; a caller's deadline must still
    // cancel a bind in progress.
    const acquire = (rejected?: string) =>
      access
        .bind({ purpose: 'helper', runModel, rejected })
        .pipe(Effect.interruptible);
    const held = yield* ScopedRef.fromAcquire(acquire());
    const { turn, usage } = yield* callModel({
      purpose: 'helper',
      binding: ScopedRef.get(held),
      reacquire: (failed, renew) =>
        ScopedRef.set(
          held,
          acquire(renew ? failed.subscriptionToken : undefined),
        ).pipe(
          Effect.tapError((error) =>
            Effect.logWarning('Could not rebind the helper model').pipe(
              Effect.annotateLogs({ error }),
            ),
          ),
          Effect.result,
        ),
      ...(retries === undefined ? {} : { retries }),
      request: {
        mode: 'foreground',
        ...(systemPrompt === undefined ? {} : { system: systemPrompt }),
        messages: [
          { role: 'user', content: [{ kind: 'text', text: userPrompt }] },
        ],
      },
      settings: stores,
      attribution,
      // No run's trace: diagnostics go to the Effect logger.
      logger: null,
      // A helper call belongs to no run's history.
      record: null,
    });
    // The turn's assistant text, from the same leaf the run loop reads.
    return { text: turnText(turn), usage };
  },
  // The binding is this call's alone: released as soon as it answers.
  Effect.scoped,
);
