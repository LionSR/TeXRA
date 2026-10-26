import { Effect, Result, Schema } from 'effect';
import { MODEL_CONFIGS, type ModelConfig, type ReasoningEffort } from 'llm-zoo';

import {
  type ApiKeyProviderId,
  decideModelRoute,
  hasUsableApiKey,
  type HostRouteFacts,
  isUnservedModel,
  modelConfig,
  type ModelRoute,
  providerDisplayName,
  resolveModelSource,
  type ReasoningRequest,
  routeConfig,
  selectModel,
} from '@texra-ai/llm';
import { StateWriteFailed } from '@platform/interfaces';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import { DEFAULT_MODELS } from '@shared/constants/defaultModels';
import {
  MODEL_AVAILABILITY_STATUS,
  type ModelAvailabilityKind,
  type UsageRoute,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

import type { SettingsStores } from '@shared/config/settings';
import { readModelSettings, routeFactsFor } from './modelSettings';
import {
  reasoningRouteOf,
  routeReasoningOf,
  servingBackend,
  type RouteReasoning,
} from './reasoningLevel';

/**
 * Every store an availability answer here reads: the secret store behind the
 * provider-key checks, and the three setting slots behind the picker's
 * persisted choices and the routing switches (the two "prefer my
 * subscription" preferences, the Kimi Code preference). Callers
 * hold them (a session's `roots`, the `Secrets` service, the stores a host
 * root threaded down) and pass them in, so this module never looks a host up
 * and never needs the caller's workspace-roots frame to answer for the
 * caller's workspace.
 */
export interface ModelOptionStores extends SettingsStores {
  readonly secrets: PlatformSecrets;
  readonly globalState: StateStore;
}

/** Availability verdict; its wording reads the route it was decided over. */
interface ModelAvailabilityStatus {
  kind: ModelAvailabilityKind;
  /** The subscription paying for the next request; absent means own keys. */
  usageRoute?: UsageRoute;
}

/**
 * Every kind whose {@link MODEL_AVAILABILITY_STATUS} entry is
 * `available: false` — derived, not hand-listed, so a kind can't be added to
 * one table (or have its `available` flip) without the other noticing.
 */
type UnavailableAvailabilityKind = {
  [
    K in ModelAvailabilityKind
  ]: (typeof MODEL_AVAILABILITY_STATUS)[K]['available'] extends true
    ? never
    : K;
}[ModelAvailabilityKind];

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
 * Per-kind unavailable-reason prose, compiler-checked the same way
 * {@link MODEL_AVAILABILITY_STATUS} is: omitting a kind here — including a
 * newly added `ModelAvailabilityKind` whose status is `available: false` —
 * is a type error instead of a silent fall-through to a generic message.
 */
const UNAVAILABLE_REASON_BUILDERS: Record<
  UnavailableAvailabilityKind,
  (reasonCtx: UnavailableReasonContext) => string
> = {
  retired: ({ model }) =>
    `Model "${model}" is retired and no longer available from its provider. Choose an active model.`,
  unserved: ({ model }) =>
    `Model "${model}" is served only through OpenRouter or GitHub Copilot, which TeXRA no longer supports. Choose another model.`,
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
 * Which providers have a usable API key, as plain data — the only provider-key
 * fact the per-model pass reads. Stage 0 fills the routing provider
 * (`kimiCode`); stage 2 fills the providers the route ladder
 * said it would consult. A provider absent from the map was never read, which
 * the verdict treats as a defect rather than as an absent key.
 */
type ProviderKeyStatuses = Partial<Record<ApiKeyProviderId, KeyStatus>>;

/**
 * The host facts every model's route is decided over, resolved once before
 * any model is routed. It deliberately excludes {@link ProviderKeyStatuses}:
 * the per-provider key statuses are read *after* routing, since that pass is
 * how the batch read learns which providers to consult.
 */
interface ModelRouteContext {
  reasoningLevels: Readonly<Record<string, ReasoningEffort>>;
  facts: HostRouteFacts;
}

/** The route facts plus the key statuses the batch read resolved for them. */
interface ModelAvailabilityContext extends ModelRouteContext {
  keyStatuses: ProviderKeyStatuses;
}

/** The one provider whose key decides a model, and the plan it pays through. */
interface ProviderKeyGate {
  needsProviderKey: ApiKeyProviderId;
  usageRoute?: UsageRoute;
}

/** A route's availability: a verdict, or the provider key still to consult. */
type RouteGate = ModelAvailabilityStatus | ProviderKeyGate;

/**
 * What stage 1 decided for one model, and the only thing stage 3 reads about
 * it.
 */
interface RoutedModel {
  /** The registry config as published: the row's hint describes the model. */
  readonly rawConfig: ModelConfig;
  /** The config the model runs with on its route: the row's cost and window. */
  readonly config: ModelConfig;
  /** The effort, thinking and mode the model string asks for. */
  readonly request: ReasoningRequest;
  readonly route: ModelRoute;
  readonly gate: RouteGate;
}

/**
 * Stage 1's decisions, keyed by model. A visible model absent from the map is
 * one the registry does not describe; nothing else is missing from it.
 */
type RoutedModels = ReadonlyMap<string, RoutedModel>;

/**
 * Stage 1: what the decided route means for availability, free of any key
 * status. A route that comes down to a direct provider key answers with that
 * provider, so the batch read that follows consults exactly the providers the
 * routes reached.
 */
function routeGate(route: ModelRoute): RouteGate {
  switch (route.kind) {
    case 'chatgpt-subscription':
      return { kind: 'subscription-access', usageRoute: route.kind };
    case 'xai-subscription':
      return { kind: 'xai-subscription-access', usageRoute: route.kind };
    case 'api-key':
      return route.usageRoute === 'api-key'
        ? { needsProviderKey: route.provider }
        : { needsProviderKey: route.provider, usageRoute: route.usageRoute };
    case 'no-api-key':
      return { kind: 'missing-key' };
    case 'unserved':
      return { kind: 'unserved' };
    case 'validation':
      return { kind: 'provider-key' };
  }
}

/**
 * Stage 3 — the per-model verdict, pure: stage 1's own answer, or the one the
 * consulted provider's key status decides.
 *
 * A provider the map has no entry for was never read, which is a different
 * fact from "read, and no key is set". Reporting it as `missing-key` would
 * tell a user with a working key that they have none, so it throws: the only
 * way to reach it is a stage-1 decision the stage-2 batch did not see.
 */
function resolveModelAvailability(
  model: string,
  gate: RouteGate,
  keyStatuses: ProviderKeyStatuses,
): ModelAvailabilityStatus {
  if (!('needsProviderKey' in gate)) return gate;
  const provider = gate.needsProviderKey;
  const usable = keyStatuses[provider];
  if (usable === undefined) {
    throw new Error(
      `Model "${model}" routes to the "${provider}" API key, but that provider's key status was never read. A route decision reached the verdict without passing through the batch read.`,
    );
  }
  if (usable === 'unreadable') return { kind: 'key-unreadable' };
  if (!usable) return { kind: 'missing-key' };
  return { kind: 'provider-key', usageRoute: gate.usageRoute };
}

/**
 * A host fact (a preference, a config switch, a stored state entry) could not
 * be read because the host's store threw. Environmental, so it is a typed
 * failure a caller recovers from like an unreadable secret store. The module's
 * own invariant ({@link resolveModelAvailability}) stays a defect.
 */
export class ModelHostFactUnreadable extends Schema.TaggedError<ModelHostFactUnreadable>()(
  'ModelHostFactUnreadable',
  {
    fact: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Give state-read failures the availability computation's public error. */
const hostFact = <A, E, R>(fact: string, read: Effect.Effect<A, E, R>) =>
  read.pipe(
    Effect.mapError(
      (cause) =>
        new ModelHostFactUnreadable({
          fact,
          message: `Could not read ${fact} from the host.`,
          cause,
        }),
    ),
  );

/**
 * Stage 0: every host fact the routes are decided over, resolved once per
 * call. The Kimi Code key status is a route fact (`readModelSettings` reads it),
 * so it seeds the key statuses.
 */
function buildAvailabilityContext(
  stores: ModelOptionStores,
): Effect.Effect<ModelAvailabilityContext, ModelHostFactUnreadable> {
  return Effect.gen(function* () {
    const settings = yield* hostFact(
      'the model settings',
      readModelSettings(stores),
    );
    const facts = routeFactsFor(settings, []);
    return {
      reasoningLevels: settings.reasoningLevels,
      facts,
      keyStatuses: { kimiCode: facts.kimiCodeKey },
    };
  });
}

/**
 * Stage 1: decide every model's route once, and keep the decision, so
 * stage 3 finishes these decisions rather than re-deciding over inputs that
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
      validation: false,
      mode: selected.request.mode,
    });
    routed.set(model, {
      rawConfig,
      config: routeConfig(rawConfig, route, ctx.facts),
      request: selected.request,
      route,
      gate: rawConfig.retired ? { kind: 'retired' } : routeGate(route),
    });
  }
  return routed;
}

/**
 * Stage 2 — read one key status for each distinct provider stage 1 said it
 * would consult, in one batch. A provider stage 0 already resolved is not read
 * again, so no model is charged a second read (or a second warning) for it.
 */
function withConsultedKeyStatuses(
  secrets: PlatformSecrets,
  routed: RoutedModels,
  ctx: ModelAvailabilityContext,
): Effect.Effect<ModelAvailabilityContext> {
  const consulted = new Set<ApiKeyProviderId>();
  for (const { gate } of routed.values()) {
    if (
      'needsProviderKey' in gate &&
      ctx.keyStatuses[gate.needsProviderKey] === undefined
    ) {
      consulted.add(gate.needsProviderKey);
    }
  }
  if (consulted.size === 0) return Effect.succeed(ctx);
  // A failed read is that provider's `unreadable` status, never "no key"
  // (which would send a user with a working key to enter it again), and warns
  // once for the provider, never once per model that consults it (#11508).
  return Effect.forEach(
    consulted,
    (provider) =>
      hasUsableApiKey(secrets, provider).pipe(
        Effect.catchTag('SecretsFailed', (failure) =>
          Effect.logWarning(
            `Failed to read ${providerDisplayName(provider)} API key status.`,
            failure.cause,
          ).pipe(Effect.as<KeyStatus>('unreadable')),
        ),
        Effect.map((usable) => [provider, usable] as const),
      ),
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map((entries) => ({
      ...ctx,
      keyStatuses: { ...ctx.keyStatuses, ...Object.fromEntries(entries) },
    })),
  );
}

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
      : Schema.decodeUnknownResult(ModelSelectionSchema)(stored);
  if (parsed === undefined) return { selection: EMPTY_MODEL_SELECTION };
  return Result.isSuccess(parsed)
    ? { selection: parsed.success }
    : { selection: EMPTY_MODEL_SELECTION, invalid: parsed.failure };
}

const reportInvalid = (invalid: Schema.SchemaError | undefined) =>
  invalid === undefined
    ? Effect.void
    : Effect.logWarning(
        `Invalid stored ${GlobalStateKey.MODEL_SELECTION}; showing the default models.`,
        invalid.message,
      );

/** A model id the registry describes but no provider TeXRA reaches serves. */
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
 * `GlobalStateKey.MODEL_SELECTION` for every host.
 */
export function getEnabledModels(state: Pick<StateStore, 'get'>) {
  return Effect.gen(function* () {
    const stored = yield* state.get(GlobalStateKey.MODEL_SELECTION);
    const { selection, invalid } = selectionOf(stored);
    yield* reportInvalid(invalid);
    return enabledOrDefaults(selection);
  });
}

/**
 * Enable or disable one model — the only writer of
 * `GlobalStateKey.MODEL_SELECTION`.
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
      key: GlobalStateKey.MODEL_SELECTION,
      message,
      cause: new Error(message),
    });
  if (input.enabled && isUnservedModelId(input.model)) {
    return Effect.fail(
      refuse(
        `Model "${input.model}" is no longer available from any provider TeXRA reaches and cannot be enabled.`,
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
    .modify(GlobalStateKey.MODEL_SELECTION, (stored) => {
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
 * Stage 3 for one model, pure: its verdict over the key statuses stage 2
 * read, and the reason a run would fail with when it cannot run.
 */
function optionOf(
  model: string,
  decision: RoutedModel | undefined,
  { keyStatuses, reasoningLevels }: ModelAvailabilityContext,
): ModelOption {
  if (!decision) {
    return {
      model,
      availability: 'unknown-model',
      unavailableReason: `Model "${model}" is not recognized.`,
    };
  }
  const { route, config } = decision;
  const { kind, usageRoute } = resolveModelAvailability(
    model,
    decision.gate,
    keyStatuses,
  );
  // cast: a kind the status table marks unavailable is one the builders
  // cover; the compiler enforces that on the table, not at this call site.
  const unavailableReason = MODEL_AVAILABILITY_STATUS[kind].available
    ? undefined
    : UNAVAILABLE_REASON_BUILDERS[kind as UnavailableAvailabilityKind]({
        model,
        source: modelSource(route, config),
      });
  const savedEffort = reasoningLevels[config.ref];
  const backend = servingBackend(config, route);
  return {
    model,
    availability: kind,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(usageRoute === undefined ? {} : { usageRoute }),
    published: decision.rawConfig,
    config,
    route,
    source: modelSource(route, config),
    savedEffort,
    // The bind's own decision over the bind's inputs (`binding.ts`
    // `reasoningOf`): the routed config, the model string's request, the
    // saved level, and the route a fresh run's backend serves.
    reasoning:
      backend === undefined
        ? undefined
        : routeReasoningOf({
            config,
            request: decision.request,
            saved: savedEffort,
            route: reasoningRouteOf(route, backend),
          }),
  };
}

/**
 * Every visible model's option, in the order they are shown — the one read
 * behind every model picker, run-model check and prospective route. The
 * facts every model shares are read once, each model is routed once, then
 * one key status is read per provider the routes consult; each option is
 * finished purely over them, so the ~157-model settings pass costs no
 * per-model awaits. Every host read fails in its typed channel
 * ({@link ModelHostFactUnreadable}). `models`, when given, is honored
 * verbatim, one option each, in order. Nothing is cached here: the sign-in
 * state is read live by design.
 */
export const readModelOptions = Effect.fn('readModelOptions')(function* (
  stores: ModelOptionStores,
  models?: readonly string[],
) {
  const routeCtx = yield* buildAvailabilityContext(stores);
  const visible =
    models ??
    visibleModelsForAccess(
      yield* hostFact(
        'the enabled-model selection',
        getEnabledModels(stores.globalState),
      ),
      routeCtx,
    );
  const routed = routeModels(visible, routeCtx);
  const context = yield* withConsultedKeyStatuses(
    stores.secrets,
    routed,
    routeCtx,
  );
  return visible.map((model) => optionOf(model, routed.get(model), context));
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
  if (!facts.chatgptSubscription) return [...models];
  for (const [model, config] of Object.entries(MODEL_CONFIGS)) {
    if (
      !isUnservedModel(config) &&
      !config.deprecated &&
      decideModelRoute(config, {
        ...facts,
        validation: false,
      }).kind === 'chatgpt-subscription'
    ) {
      models.add(model);
    }
  }
  return [...models];
}
