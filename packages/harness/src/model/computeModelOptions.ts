import { Effect, Result, Schema } from 'effect';

import {
  type ApiKeyProviderId,
  decideModelRoute,
  hasUsableApiKey,
  isUnservedModel,
  MODEL_CONFIGS,
  modelConfig,
  type ModelConfig,
  type ModelRoute,
  providerDisplayName,
  type ReasoningEffort,
  type ReasoningRequest,
  resolveModelSource,
  routeConfig,
  type RouteFacts,
  selectModel,
} from '@texra-ai/llm';
import { Secrets } from '@platform/secrets';
import {
  StateWriteFailed,
  type SettingsStores,
  type StateStore,
} from '@shared/config/settings';
import { DEFAULT_MODELS } from '@shared/constants/defaultModels';
import {
  MODEL_AVAILABILITY_STATUS,
  type ModelAvailabilityKind,
  type UsageRoute,
} from '@shared/schemas';
import type { StateKey } from '@shared/state/stateSettings';

import { readModelSettings, routeFactsFor } from './modelSettings';
import {
  routeReasoningOf,
  servingBackend,
  type RouteReasoning,
} from './reasoningLevel';

/** Availability verdict; its wording reads the route it was decided over. */
interface ModelAvailabilityStatus {
  kind: ModelAvailabilityKind;
  /** The subscription paying for the next request; absent means own keys. */
  usageRoute?: UsageRoute;
}

/**
 * Everything an unavailable-reason builder needs to word its message — all of
 * it data the route ladder already resolved, so no builder reads a host.
 */
interface UnavailableReasonContext {
  readonly model: string;
  /** The model source the route bills, for the missing-key sentence. */
  readonly source: string;
}

/**
 * Per-kind unavailable-reason prose, compiler-checked against
 * {@link MODEL_AVAILABILITY_STATUS}: a kind whose status is
 * `available: false` must have a builder, and an available one must have
 * none, so a kind can't be added to one table (or have its `available` flip)
 * without the other noticing.
 */
const UNAVAILABLE_REASON_BUILDERS: {
  readonly [
    K in ModelAvailabilityKind
  ]: (typeof MODEL_AVAILABILITY_STATUS)[K]['available'] extends true
    ? undefined
    : (reasonCtx: UnavailableReasonContext) => string;
} = {
  'provider-key': undefined,
  'subscription-access': undefined,
  'xai-subscription-access': undefined,
  retired: ({ model }) =>
    `Model "${model}" is retired and no longer available from its provider. Choose an active model.`,
  unserved: ({ model }) =>
    `Model "${model}" is served only through OpenRouter or GitHub Copilot, which this build no longer supports. Choose another model.`,
  'missing-key': ({ model, source }) =>
    `Model "${model}" requires your ${providerDisplayName(source)} API key. Provide it to continue.`,
  'key-unreadable': ({ model, source }) =>
    `Model "${model}" needs your ${providerDisplayName(source)} API key, which could not be read from secret storage. Check that the store is unlocked and readable, then retry.`,
  // Unreachable from `optionOf` (it answers "not recognized"
  // first), but an `available: false` kind the table must still cover.
  'unknown-model': ({ model }) => `Model "${model}" is not recognized.`,
};

/** A provider's key as read: usable, absent, or a store that could not be
 *  read, which is not an absent key. */
type KeyStatus = boolean | 'unreadable';

/**
 * The provider keys stage 0 already read (the Kimi Code key, a route fact),
 * which stage 2 does not read again.
 */
type ProviderKeyStatuses = Partial<Record<ApiKeyProviderId, KeyStatus>>;

/**
 * The host facts every model's route is decided over, resolved once before
 * any model is routed, with the provider keys stage 0 read among them. The
 * other providers' keys are read *after* routing, since that pass is how the
 * batch read learns which providers to consult.
 */
interface ModelRouteContext {
  reasoningLevels: Readonly<Record<string, ReasoningEffort>>;
  facts: RouteFacts;
  keyStatuses: ProviderKeyStatuses;
}

/** What stage 1 decided for one model, which stage 2 gives its verdict. */
interface RoutedModel {
  /** The registry config as published: the row's hint describes the model. */
  readonly rawConfig: ModelConfig;
  /** The config the model runs with on its route: the row's cost and window. */
  readonly config: ModelConfig;
  /** The effort, thinking and mode the model string asks for. */
  readonly request: ReasoningRequest;
  readonly route: ModelRoute;
}

/**
 * Stage 1's decisions, keyed by model. A visible model absent from the map is
 * one the registry does not describe; nothing else is missing from it.
 */
type RoutedModels = ReadonlyMap<string, RoutedModel>;

/**
 * The verdict a model's route gives on its own, or the provider whose key
 * decides it (stage 2 reads that key). Retired models need no provider key.
 */
function routeVerdict({ rawConfig, route }: RoutedModel):
  | { readonly verdict: ModelAvailabilityStatus }
  | {
      readonly keyOf: ApiKeyProviderId;
      readonly usageRoute: UsageRoute | undefined;
    } {
  if (rawConfig.retired) return { verdict: { kind: 'retired' } };
  switch (route.kind) {
    case 'chatgpt-subscription':
      return {
        verdict: { kind: 'subscription-access', usageRoute: route.kind },
      };
    case 'xai-subscription':
      return {
        verdict: { kind: 'xai-subscription-access', usageRoute: route.kind },
      };
    case 'no-api-key':
      return { verdict: { kind: 'missing-key' } };
    case 'unserved':
      return { verdict: { kind: 'unserved' } };
    case 'api-key':
      return {
        keyOf: route.provider,
        usageRoute:
          route.usageRoute === 'api-key' ? undefined : route.usageRoute,
      };
  }
}

/** The verdict of a route that bills a key, over that key's status. */
function keyVerdict(
  status: KeyStatus,
  usageRoute: UsageRoute | undefined,
): ModelAvailabilityStatus {
  if (status === 'unreadable') return { kind: 'key-unreadable' };
  if (!status) return { kind: 'missing-key' };
  return { kind: 'provider-key', usageRoute };
}

/**
 * Stage 0: every host fact the routes are decided over, resolved once per
 * call. The Kimi Code key status is a route fact (`readModelSettings` reads it),
 * so it seeds the key statuses.
 */
const buildAvailabilityContext = Effect.fn('buildAvailabilityContext')(
  function* (stores: SettingsStores) {
    const settings = yield* readModelSettings(stores);
    return {
      reasoningLevels: settings.reasoningLevels,
      facts: routeFactsFor(settings, []),
      keyStatuses: { kimiCode: settings.kimiCodeKey },
    };
  },
);

/**
 * Stage 1: decide every model's route once, and keep the decision, so
 * stages 2 and 3 finish these decisions rather than re-deciding over inputs that
 * may have moved while the key read was in flight.
 */
function routeModels(
  models: readonly string[],
  ctx: ModelRouteContext,
): RoutedModels {
  const routed = new Map<string, RoutedModel>();
  for (const model of models) {
    if (routed.has(model)) continue;
    const selected = selectModel(model);
    if (!selected) continue;
    const rawConfig = selected.config;
    const route = decideModelRoute(rawConfig, {
      ...ctx.facts,
      mode: selected.request.mode,
    });
    routed.set(model, {
      rawConfig,
      config: routeConfig(rawConfig, route),
      request: selected.request,
      route,
    });
  }
  return routed;
}

/** One routed model with its verdict: what stage 3 words. */
interface DecidedModel {
  readonly decision: RoutedModel;
  readonly verdict: ModelAvailabilityStatus;
}

/**
 * Stage 2 — each routed model's verdict. A route that bills a key reads that
 * provider's status once for every model that consults it, all providers in
 * one concurrent batch; a provider stage 0 already resolved is not read
 * again, so no model is charged a second read (or a second warning) for it.
 * A failed read is that provider's `unreadable` status, never "no key"
 * (which would send a user with a working key to enter it again), and warns
 * once for the provider, never once per model that consults it (#11508).
 */
const decideVerdicts = Effect.fn('decideVerdicts')(function* (
  routed: RoutedModels,
  { keyStatuses }: ModelRouteContext,
) {
  const secrets = yield* Secrets;
  const reads = new Map<ApiKeyProviderId, Effect.Effect<KeyStatus>>();
  const verdicts: [
    string,
    RoutedModel,
    Effect.Effect<ModelAvailabilityStatus>,
  ][] = [];
  for (const [model, decision] of routed) {
    const decided = routeVerdict(decision);
    if ('verdict' in decided) {
      verdicts.push([model, decision, Effect.succeed(decided.verdict)]);
      continue;
    }
    const provider = decided.keyOf;
    let read = reads.get(provider);
    if (read === undefined) {
      const seeded = keyStatuses[provider];
      read =
        seeded === undefined
          ? yield* Effect.cached(
              hasUsableApiKey(secrets, provider).pipe(
                Effect.catchTag('SecretsFailed', (failure) =>
                  Effect.logWarning(
                    `Failed to read ${providerDisplayName(provider)} API key status.`,
                    failure.cause,
                  ).pipe(Effect.as<KeyStatus>('unreadable')),
                ),
              ),
            )
          : Effect.succeed(seeded);
      reads.set(provider, read);
    }
    verdicts.push([
      model,
      decision,
      Effect.map(read, (status) => keyVerdict(status, decided.usageRoute)),
    ]);
  }
  const decided = yield* Effect.forEach(
    verdicts,
    ([model, decision, verdict]) =>
      Effect.map(verdict, (v): readonly [string, DecidedModel] => [
        model,
        { decision, verdict: v },
      ]),
    { concurrency: 'unbounded' },
  );
  return new Map(decided);
});

/**
 * The user's picker choices as a delta over {@link DEFAULT_MODELS}, so a change
 * to the curated defaults reaches every user while a default they turned off
 * stays off and a model they turned on stays on.
 */
const ModelSelectionSchema = Schema.Struct({
  enabledExtras: Schema.Array(Schema.String),
  disabledDefaults: Schema.Array(Schema.String),
});
type ModelSelection = typeof ModelSelectionSchema.Type;

/** The model selection's key. Its absence is the empty delta, read here
 *  rather than by a decoding default, so a corrupt record is reported. */
export const MODEL_SELECTION_KEY = {
  key: 'modelSelection',
  slot: 'globalState',
  schema: ModelSelectionSchema,
} as const satisfies StateKey<ModelSelection>;

const EMPTY_MODEL_SELECTION: ModelSelection = {
  enabledExtras: [],
  disabledDefaults: [],
};

/**
 * An unreadable stored selection reads as the empty delta — the defaults —
 * with its error for the caller to report, and is not rewritten: the next
 * picker toggle re-encodes a valid delta from the list shown.
 */
function selectionOf(stored: unknown) {
  const parsed =
    stored === undefined
      ? undefined
      : Schema.decodeUnknownResult(MODEL_SELECTION_KEY.schema)(stored);
  if (parsed === undefined) return { selection: EMPTY_MODEL_SELECTION };
  return Result.isSuccess(parsed)
    ? { selection: parsed.success }
    : { selection: EMPTY_MODEL_SELECTION, invalid: parsed.failure };
}

const reportInvalid = (invalid: Schema.SchemaError | undefined) =>
  invalid === undefined
    ? Effect.void
    : Effect.logWarning(
        `Invalid stored ${MODEL_SELECTION_KEY.key}; showing the default models.`,
        invalid.message,
      );

/** A registry model that no provider this build reaches serves. */
function isUnservedModelId(model: string): boolean {
  const config = modelConfig(model);
  return config !== undefined && isUnservedModel(config);
}

/**
 * Unserved models drop out here, so no startup pass sweeps persisted state.
 * An explicitly enabled default is also kept in `enabledExtras`, so it stays
 * on if the curated defaults later drop it; the set de-duplicates it.
 */
function enabledModelsOf(selection: ModelSelection): readonly string[] {
  const disabled = new Set(selection.disabledDefaults);
  return [
    ...new Set([
      ...DEFAULT_MODELS.filter((model) => !disabled.has(model)),
      ...selection.enabledExtras,
    ]),
  ].filter((model) => !isUnservedModelId(model));
}

/**
 * When every enabled extra is unserved and every default is off, the picker
 * would be empty with no way back out from the UI; it shows the defaults.
 */
function enabledOrDefaults(selection: ModelSelection): readonly string[] {
  const enabled = enabledModelsOf(selection);
  return enabled.length > 0 ? enabled : DEFAULT_MODELS;
}

/**
 * The models the pickers show — the single reader of
 * {@link MODEL_SELECTION_KEY} for every host.
 */
export const getEnabledModels = Effect.fn('getEnabledModels')(function* (
  state: Pick<StateStore, 'get'>,
) {
  const stored = yield* state.get(MODEL_SELECTION_KEY.key);
  const { selection, invalid } = selectionOf(stored);
  yield* reportInvalid(invalid);
  return enabledOrDefaults(selection);
});

/**
 * Enable or disable one model — the only writer of
 * {@link MODEL_SELECTION_KEY}.
 *
 * Two invariants: at least one model stays enabled, and an unserved model is
 * never enabled. Either violation fails with `StateWriteFailed`.
 */
export function setModelEnabled(input: {
  readonly model: string;
  readonly enabled: boolean;
  readonly state: StateStore;
}) {
  // Refusals are typed failures, never throws, so a UI can surface them.
  const refuse = (message: string) =>
    new StateWriteFailed({
      key: MODEL_SELECTION_KEY.key,
      message,
      cause: new Error(message),
    });
  if (input.enabled && isUnservedModelId(input.model)) {
    return Effect.fail(
      refuse(
        `Model "${input.model}" is no longer available from any provider this build reaches and cannot be enabled.`,
      ),
    );
  }
  let invalid: Schema.SchemaError | undefined;
  // Edit the list the picker shows — including the all-defaults fallback — and
  // re-encode the delta from it, so a write never acts on a hidden state. An
  // explicit enable is recorded in `enabledExtras` even for a default, so it
  // survives the model later leaving the curated defaults. A helper model
  // disabled here is not rewritten: `getHelperModelName` checks it at read.
  return input.state
    .modify(MODEL_SELECTION_KEY.key, (stored) => {
      const read = selectionOf(stored);
      invalid = read.invalid;
      const others = enabledOrDefaults(read.selection).filter(
        (model) => model !== input.model,
      );
      const toggled = input.enabled ? [...others, input.model] : others;
      const next: ModelSelection = {
        enabledExtras: [
          ...new Set([
            ...read.selection.enabledExtras.filter((model) =>
              toggled.includes(model),
            ),
            ...(input.enabled ? [input.model] : []),
          ]),
        ],
        disabledDefaults: DEFAULT_MODELS.filter(
          (model) => !toggled.includes(model),
        ),
      };
      return enabledModelsOf(next).length > 0
        ? Result.succeed(next)
        : Result.fail(
            refuse(
              'At least one model must stay enabled. Enable another model before disabling this one.',
            ),
          );
    })
    .pipe(
      Effect.map(enabledModelsOf),
      Effect.ensuring(Effect.suspend(() => reportInvalid(invalid))),
    );
}

/**
 * One visible model's option: whether it can run now, the route that decided
 * it, and what that route means for the next request. The registry does not
 * describe an `unknown-model`. Each host words a row from it (the app's
 * `modelOptionsFrom`).
 */
export type ModelOption =
  | {
      readonly model: string;
      readonly availability: 'unknown-model';
      readonly unavailableReason: string;
      readonly usageRoute?: undefined;
    }
  | {
      readonly model: string;
      readonly availability: ModelAvailabilityKind;
      /** Why it cannot run now, worded as a run would fail; absent when it can. */
      readonly unavailableReason?: string;
      /** The subscription paying for the next request; absent means own keys. */
      readonly usageRoute?: UsageRoute;
      /** The registry config as published: what the model is. */
      readonly published: ModelConfig;
      /** The config it runs with on its route. */
      readonly config: ModelConfig;
      readonly route: ModelRoute;
      /** The key its route bills, or the model's own source. */
      readonly source: string;
      /** The user's saved reasoning effort for it. */
      readonly savedEffort: ReasoningEffort | undefined;
      /**
       * What a run on the route sends for reasoning; absent when the model
       * does not reason there, or no backend serves the route (a model
       * with no route, whose row is unavailable).
       */
      readonly reasoning: RouteReasoning | undefined;
    };

/**
 * Stage 3 for one model, pure: the verdict stage 2 decided, and the reason
 * a run would fail with when it cannot run.
 */
function optionOf(
  model: string,
  decided: DecidedModel | undefined,
  { reasoningLevels }: ModelRouteContext,
): ModelOption {
  if (!decided) {
    return {
      model,
      availability: 'unknown-model',
      unavailableReason: `Model "${model}" is not recognized.`,
    };
  }
  const { decision } = decided;
  const { route, config } = decision;
  const source = modelSource(route, config);
  const { kind, usageRoute } = decided.verdict;
  const unavailableReason = UNAVAILABLE_REASON_BUILDERS[kind]?.({
    model,
    source,
  });
  const savedEffort = reasoningLevels[config.ref];
  return {
    model,
    availability: kind,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(usageRoute === undefined ? {} : { usageRoute }),
    published: decision.rawConfig,
    config,
    route,
    source,
    savedEffort,
    // The bind's own decision over the bind's inputs (`binding.ts`
    // `reasoningOf`): the routed config, the model string's request, the
    // saved level and the route. A model no backend serves has none to show.
    reasoning:
      servingBackend(config) === undefined
        ? undefined
        : routeReasoningOf({
            config,
            request: decision.request,
            saved: savedEffort,
            route,
          }),
  };
}

/**
 * Every visible model's option, in the order they are shown — the one read
 * behind every model picker, run-model check and prospective route. The
 * facts every model shares are read once, each model is routed once, then
 * one key status is read per provider the routes consult; each option is
 * finished purely over them, so the ~157-model settings pass costs no
 * per-model awaits. Each read fails with its own error: a settings or key
 * read as itself, a subscription session as its route (`RouteUnavailable`,
 * with whether it needs a sign-in). `models`, when given, is honored
 * verbatim, one option each, in order. Nothing is cached here: the sign-in
 * state is read live by design. `stores` are the caller's setting slots (a
 * session's `roots`); provider keys and sign-ins come from the process
 * {@link Secrets} service.
 */
export const readModelOptions = Effect.fn('readModelOptions')(function* (
  stores: SettingsStores,
  models?: readonly string[],
) {
  const routeCtx = yield* buildAvailabilityContext(stores);
  const visible =
    models ??
    visibleModelsForAccess(
      yield* getEnabledModels(stores.globalState),
      routeCtx,
    );
  const decided = yield* decideVerdicts(
    routeModels(visible, routeCtx),
    routeCtx,
  );
  return visible.map((model) => optionOf(model, decided.get(model), routeCtx));
});

/** The source a row is grouped and worded under: the key its route bills. */
function modelSource(route: ModelRoute, config: ModelConfig): string {
  return route.kind === 'api-key' ? route.provider : resolveModelSource(config);
}

/** The enabled models, plus every model the ChatGPT subscription serves. */
function visibleModelsForAccess(
  configuredModels: readonly string[],
  { facts }: ModelRouteContext,
): readonly string[] {
  const models = new Set(configuredModels);
  if (!facts.plans.includes('chatgpt-subscription')) return [...models];
  for (const [model, config] of Object.entries(MODEL_CONFIGS)) {
    if (
      !config.deprecated &&
      decideModelRoute(config, facts).kind === 'chatgpt-subscription'
    ) {
      models.add(model);
    }
  }
  return [...models];
}
