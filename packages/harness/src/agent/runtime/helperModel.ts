/**
 * The helper model: one configured "helper model" setting behind session
 * descriptions and draft polishing. Every use is one non-streaming turn, text
 * in, text out, on a binding `ModelAccess` makes for the helper.
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
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import type { UsageLog } from '@shared/usageLog';

import { callModel } from './run/modelCall';
import { turnText } from './run/turnText';
import type { RouteRetries } from './run/invocation';
import type { UsageAttribution } from './run/pricing';
import type { HttpClient } from 'effect/http';

/** A single non-streaming helper-model text completion. */
interface HelperPrompt {
  /** User message content. */
  readonly userPrompt: string;
  /** Optional system prompt. */
  readonly systemPrompt?: string;
}

/**
 * One helper call: bind the configured helper model for this call alone and
 * run one completion through the one retry loop (`run/invocation.ts`),
 * gated on the process's retry gate, priced and reported to the usage log as
 * `attribution`. No row is written. Returns the turn's assistant text.
 * `stores` are the asking session's setting slots and the process secret
 * store: the binding, the retry limit and the usage consent read them.
 */
export const helperCall = Effect.fn('helperCall')(
  function* (
    stores: ModelOptionStores,
    { userPrompt, systemPrompt }: HelperPrompt,
    attribution: UsageAttribution,
    /** Automatic retries; the configured batch when absent. */
    retries?: number,
  ): Effect.fn.Return<
    string,
    CallFailure | Error,
    | Scope.Scope
    | LanguageModel
    | HttpClient.HttpClient
    | UsageLog
    | RouteRetries
  > {
    const access = yield* Effect.provide(ModelAccess, modelAccessLayer(stores));
    // ScopedRef masks its acquisition; a caller's deadline must still
    // cancel a bind in progress.
    const acquire = (renew: boolean) =>
      access.bind({ purpose: 'helper', renew }).pipe(Effect.interruptible);
    const held = yield* ScopedRef.fromAcquire(acquire(false));
    const { turn } = yield* callModel({
      purpose: 'helper',
      binding: ScopedRef.get(held),
      reacquire: (_failed, renew) =>
        ScopedRef.set(held, acquire(renew)).pipe(
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
    return turnText(turn);
  },
  // The binding is this call's alone: released as soon as it answers.
  Effect.scoped,
);
