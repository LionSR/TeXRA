/**
 * The helper model: one configured "helper model" setting behind session
 * descriptions and draft polishing. Every use is one non-streaming turn, text
 * in, text out; the model is bound through the same route the run loop binds
 * under.
 *
 * A helper call is gated, priced and reported to the usage log like every
 * model call; it writes no run history row, because it belongs to no run's history.
 */
import { Data, Effect, Exit, Ref, Scope } from 'effect';

import {
  modelUnavailableReasonFrom,
  readModelAvailabilityInputs,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import type { UsageLog } from '@shared/usageLog';

import { getHelperModelName } from './helperModelName';
import { bindModel, type BoundModel } from './run/modelBinding';
import { callModel } from './run/modelCall';
import { turnText } from './run/turnText';
import type { RouteRetries } from './run/invocation';
import type { UsageAttribution } from './run/pricing';
import type { SessionHandle } from './SessionHandle';
import type { HttpClient } from 'effect/http';

/**
 * The configured helper model cannot serve right now (no key, disabled,
 * unknown name). An expected state, not a defect: callers degrade quietly.
 */
export class HelperModelUnavailable extends Data.TaggedError(
  'HelperModelUnavailable',
)<{ readonly message: string }> {}

/**
 * Bind the configured helper model into the caller's scope.
 *
 * `stores` are the secret store and the three setting slots the caller
 * already holds (a session's `roots` plus the `Secrets` service, or the stores
 * a host root threaded down), so helper resolution, the model toggles and the
 * OpenRouter preference all read the same stores as the run that asked for it.
 * A helper has no persisted backend; it never takes the tool-use
 * output haircut.
 */
const helperModel = Effect.fn('helperModel')(function* (
  stores: ModelOptionStores,
): Effect.fn.Return<
  BoundModel,
  HelperModelUnavailable | Error,
  Scope.Scope | LanguageModel | HttpClient.HttpClient
> {
  const modelName = yield* getHelperModelName(stores);
  const inputs = yield* readModelAvailabilityInputs(stores, [modelName]);
  const reason = modelUnavailableReasonFrom(inputs, modelName);
  // An available model is a recognized one (`modelUnavailableReasonFrom`
  // routes only catalog models), so the binding finds its catalog entry.
  if (reason) return yield* new HelperModelUnavailable({ message: reason });
  return yield* bindModel({
    modelId: modelName,
    stores,
    // One-shot text: the whole output budget.
    textOnly: true,
    // Helper calls are deterministic one-shots, never sampled.
    temperature: 0,
  });
});

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
 * `attribution`. No row is written. Returns the turn's assistant text. The
 * binding, the retry limit and the usage consent read one set of stores: the
 * session's setting slots and the process `secrets`.
 */
export const helperCall = Effect.fn('helperCall')(
  function* (
    session: Pick<SessionHandle, 'roots'>,
    secrets: ModelOptionStores['secrets'],
    { userPrompt, systemPrompt }: HelperPrompt,
    attribution: UsageAttribution,
    /** Automatic retries; the configured batch when absent. */
    retries?: number,
  ): Effect.fn.Return<
    string,
    HelperModelUnavailable | Error,
    | Scope.Scope
    | LanguageModel
    | HttpClient.HttpClient
    | UsageLog
    | RouteRetries
  > {
    // Each binding in its own fork of this call's scope, so a reacquired
    // connection retires the dead one at once.
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<
      LanguageModel | HttpClient.HttpClient
    >();
    const stores: ModelOptionStores = { ...session.roots, secrets };
    const bindFresh = Effect.gen(function* () {
      const fork = yield* Scope.fork(scope);
      const bound = yield* helperModel(stores).pipe(Scope.provide(fork));
      return { bound, fork };
    });
    const held = yield* Ref.make(yield* bindFresh);
    const { turn } = yield* callModel({
      purpose: 'helper',
      binding: Effect.map(Ref.get(held), ({ bound }) => bound),
      reacquire: () =>
        Effect.gen(function* () {
          const retired = yield* Ref.getAndSet(held, yield* bindFresh);
          yield* Scope.close(retired.fork, Exit.void);
        }).pipe(
          Effect.provideContext(context),
          Effect.catch((error) =>
            Effect.logWarning('Could not rebind the helper model').pipe(
              Effect.annotateLogs({ error }),
            ),
          ),
        ),
      ...(retries === undefined ? {} : { retries }),
      request: {
        mode: 'foreground',
        ...(systemPrompt === undefined ? {} : { system: systemPrompt }),
        messages: [
          { role: 'user', content: [{ kind: 'text', text: userPrompt }] },
        ],
      },
      settings: session.roots,
      secrets,
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
