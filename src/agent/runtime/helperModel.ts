/**
 * The helper model: one configured "helper model" setting behind session
 * descriptions, instruction polishing, AI-assisted agent creation and the
 * LaTeX text connector. Every use is one non-streaming turn, text in, text
 * out; the model is bound through the same route the run loop binds under.
 *
 * A helper call is gated, priced and reported to the usage log like every
 * model call; it writes no ledger row, because it belongs to no run's history.
 */
import { MODEL_CONFIGS } from 'llm-zoo';
import { Data, Effect, type Scope } from 'effect';

import { writeLogLine } from '@logger/logSink';
import {
  modelUnavailableReasonFrom,
  readModelAvailabilityInputs,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import { AgentCategory } from '@shared/schemas';
import type { UsageLog } from '@shared/usageLog';

import { getHelperModelName } from './helperModelName';
import { bindModel, type BoundModel } from './run/modelBinding';
import { callModel, type UsageAttribution } from './run/modelCall';
import { turnText } from './run/turnText';
import type { SessionHandle } from './SessionHandle';
import type { HttpClient } from 'effect/unstable/http';

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
 * A helper has no persisted conversation format; it never takes the tool-use
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
  if (reason) return yield* new HelperModelUnavailable({ message: reason });
  const config = MODEL_CONFIGS[modelName];
  if (!config) {
    return yield* new HelperModelUnavailable({
      message: `Model "${modelName}" is not recognized.`,
    });
  }
  return yield* bindModel({
    config,
    stores,
    compatibilityKey: null,
    agentCategory: AgentCategory.Workflow,
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

/** Pricing warnings of a call no run's trace can show. */
const HELPER_LOG = {
  warn: (message: string) => writeLogLine('WARN', 'HelperModel', message),
  debug: (message: string) => writeLogLine('DEBUG', 'HelperModel', message),
};

/**
 * One helper call: bind the configured helper model for this call alone and
 * run one completion through the invoker's call path (`run/modelCall.ts`),
 * gated on the session's retry gate, priced and reported to the usage log as
 * `attribution`. No row is written. Returns the turn's assistant text.
 */
export const helperCall = Effect.fn('helperCall')(
  function* (
    session: Pick<SessionHandle, 'modelRetries' | 'roots'>,
    stores: ModelOptionStores,
    { userPrompt, systemPrompt }: HelperPrompt,
    attribution: UsageAttribution,
  ): Effect.fn.Return<
    string,
    HelperModelUnavailable | Error,
    Scope.Scope | LanguageModel | HttpClient.HttpClient | UsageLog
  > {
    const { turn } = yield* callModel({
      purpose: 'helper',
      bound: yield* helperModel(stores),
      request: {
        mode: 'foreground',
        ...(systemPrompt === undefined ? {} : { system: systemPrompt }),
        messages: [
          { role: 'user', content: [{ kind: 'text', text: userPrompt }] },
        ],
      },
      gate: session.modelRetries,
      settings: session.roots,
      attribution,
      logger: HELPER_LOG,
    });
    // The turn's assistant text, from the same leaf the run loop reads.
    return turnText(turn);
  },
  // The binding is this call's alone: released as soon as it answers.
  Effect.scoped,
);
