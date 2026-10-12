import { Data, Effect, Result } from 'effect';
import { MODEL_CONFIGS, type ModelConfig, type ReasoningEffort } from 'llm-zoo';
import { z } from 'zod';

import {
  type ApiKeyProviderId,
  decideModelRoute,
  hasUsableApiKey,
  type HostRouteFacts,
  modelConfig,
  type ModelRoute,
  providerDisplayName,
  resolveModelSource,
  routeConfig,
  selectModel,
} from '@texra-ai/llm';
import { StateWriteFailed } from '@platform/interfaces';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import { DEFAULT_MODELS } from '@shared/constants/defaultModels';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  MODEL_AVAILABILITY_STATUS,
  type ModelAvailabilityKind,
  type UsageRoute,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { readModelSettings, routeFactsFor } from './modelSettings';
import {
  copilotRouteUnavailableReason,
  discoverCopilotRoutes,
  type CopilotModelRoute,
} from './copilotRouting';

/**
 * Every store an availability answer here reads: the secret store behind the
 * provider-key checks, and the three setting slots behind the picker's
 * persisted choices and the routing switches (the OpenRouter toggle, the two
 * "prefer my subscription" preferences, the Kimi Code preference). Callers
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
  readonly route: ModelRoute<CopilotModelRoute>;
}

/**
 * Unavailable reason for both Copilot kinds: the dispatch path's own wording
 * for the route the model was decided onto, so the picker shows the sentence
 * a run would fail with. Only an allowed route has no reason, and an allowed
 * route never reaches an unavailable kind.
 */
function copilotUnavailableReason({
  model,
  route,
}: UnavailableReasonContext): string {
  return (
    copilotRouteUnavailableReason(
      model,
      route.kind === 'copilot' ? route.route : undefined,
    ) ?? `Model "${model}" is currently unavailable through Copilot in VS Code.`
  );
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
  'provider-unavailable': ({ model }) =>
    `Model "${model}" requires a provider request mode that OpenRouter does not support. Disable OpenRouter and use the provider API directly.`,
  'missing-key': ({ model, source, route }) => {
    if (route.kind === 'openrouter') {
      return `Model "${model}" requires an OpenRouter API key.`;
    }
    const providerName = providerDisplayName(source);
    return `Model "${model}" requires your ${providerName} API key. Provide it to continue.`;
  },
  'copilot-consent-required': copilotUnavailableReason,
  'copilot-unavailable': copilotUnavailableReason,
  // Unreachable from `modelUnavailableReasonFrom` (it answers "not recognized"
  // first), but an `available: false` kind the table must still cover.
  'unknown-model': ({ model }) => `Model "${model}" is not recognized.`,
};

/**
 * Which providers have a usable API key, as plain data — the only provider-key
 * fact the per-model pass reads. Stage 0 fills the two routing providers
 * (`openRouter`, `kimiCode`); stage 2 fills the providers the route ladder
 * said it would consult. A provider absent from the map was never read, which
 * the verdict treats as a defect rather than as an absent key.
 */
type ProviderKeyStatuses = Partial<Record<ApiKeyProviderId, boolean>>;

/**
 * The host facts every model's route is decided over, resolved once before
 * any model is routed. It deliberately excludes {@link ProviderKeyStatuses}:
 * the per-provider key statuses are read *after* routing, since that pass is
 * how the batch read learns which providers to consult.
 */
interface ModelRouteContext {
  reasoningLevels: Readonly<Record<string, ReasoningEffort>>;
  /** Models whose Copilot route the user prefers. */
  copilotModels: readonly string[];
  hasOpenRouter: boolean;
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
  readonly route: ModelRoute<CopilotModelRoute>;
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
 * routes reached. The discovered Copilot route rides on the decision, so the
 * row's config and an unavailable route's sentence read it there, never the
 * editor.
 */
function routeGate(
  route: ModelRoute<CopilotModelRoute>,
  ctx: ModelRouteContext,
): RouteGate {
  switch (route.kind) {
    case 'copilot':
      // Consent and temporary unavailability are route states on the one
      // canonical row, never a reason to fall back to another transport.
      return { kind: `copilot-${route.route?.access ?? 'unavailable'}` };
    case 'openrouter-unsupported':
      return { kind: 'provider-unavailable' };
    case 'chatgpt-subscription':
      return { kind: 'subscription-access', usageRoute: route.kind };
    case 'xai-subscription':
      return { kind: 'xai-subscription-access', usageRoute: route.kind };
    case 'openrouter':
      return ctx.hasOpenRouter
        ? { kind: 'openrouter-key' }
        : { kind: 'missing-key' };
    case 'api-key':
      return route.usageRoute === 'api-key'
        ? { needsProviderKey: route.provider }
        : { needsProviderKey: route.provider, usageRoute: route.usageRoute };
    case 'no-api-key':
      return { kind: 'missing-key' };
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
  if (!usable) return { kind: 'missing-key' };
  return { kind: 'provider-key', usageRoute: gate.usageRoute };
}

/**
 * A host fact (a preference, a config switch, a stored state entry) could not
 * be read because the host's store threw. Environmental, so it is a typed
 * failure a caller recovers from like an unreadable secret store. The module's
 * own invariant ({@link resolveModelAvailability}) stays a defect.
 */
export class ModelHostFactUnreadable extends Data.TaggedError(
  'ModelHostFactUnreadable',
)<{
  readonly fact: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

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
 * One key status per provider, read once. A failed read degrades that provider
 * to unavailable and warns once for the provider, never once per model that
 * consults it (#11508), so one unreadable store cannot flood the log.
 */
function readProviderKeyStatuses(
  secrets: PlatformSecrets,
  providers: readonly ApiKeyProviderId[],
): Effect.Effect<ProviderKeyStatuses> {
  return Effect.forEach(
    providers,
    (provider) =>
      hasUsableApiKey(secrets, provider).pipe(
        Effect.catchTag('SecretsFailed', (failure) =>
          Effect.logWarning(
            `Failed to read ${providerDisplayName(provider)} API key status; treating it as unavailable.`,
            failure.cause,
          ).pipe(Effect.as(false)),
        ),
        Effect.map((usable) => [provider, usable] as const),
      ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

/**
 * Stage 0: every host fact the routes are decided over, resolved once per
 * call. The Kimi Code key status is a route fact (`readModelSettings` reads it),
 * so it seeds the key statuses, and the OpenRouter branch is decided by the
 * OpenRouter key alone.
 */
function buildAvailabilityContext(
  stores: ModelOptionStores,
): Effect.Effect<ModelAvailabilityContext, ModelHostFactUnreadable> {
  return Effect.gen(function* () {
    const [settings, openRouterKey] = yield* Effect.all(
      [
        hostFact('the model settings', readModelSettings(stores)),
        readProviderKeyStatuses(stores.secrets, ['openRouter']),
      ] as const,
      { concurrency: 'unbounded' },
    );
    const facts = routeFactsFor(settings, []);
    return {
      reasoningLevels: settings.reasoningLevels,
      copilotModels: settings.copilotModels,
      facts,
      hasOpenRouter: openRouterKey.openRouter === true,
      keyStatuses: { ...openRouterKey, kimiCode: facts.kimiCodeKey },
    };
  });
}

/** A failed discovery (the port warns) shows each Copilot row unavailable. */
const presentedCopilotRoutes = discoverCopilotRoutes().pipe(
  Effect.orElseSucceed((): ReadonlyMap<string, CopilotModelRoute> => new Map()),
);

/**
 * Stage 1: decide every model's route once, and keep the decision. Each live
 * input (the editor's routes, the Copilot preference, the stage-0 facts) is
 * therefore read once per computation: stage 3 finishes these decisions
 * rather than re-deciding over inputs that may have moved while the key read
 * was in flight.
 */
function routeModels(models: readonly string[], ctx: ModelRouteContext) {
  return Effect.gen(function* () {
    const routed = new Map<string, RoutedModel>();
    let copilotRoutes: ReadonlyMap<string, CopilotModelRoute> | undefined;
    for (const model of models) {
      if (routed.has(model)) continue;
      const selected = selectModel(model);
      if (!selected) continue;
      const rawConfig = selected.config;
      // A retired row settles without its Copilot preference.
      const prefersCopilot =
        !rawConfig.retired && ctx.copilotModels.includes(rawConfig.ref);
      const copilotRoute = prefersCopilot
        ? (copilotRoutes ??= yield* presentedCopilotRoutes).get(rawConfig.ref)
        : undefined;
      const route = decideModelRoute(rawConfig, {
        ...ctx.facts,
        validation: false,
        prefersCopilot,
        copilotRoute,
        mode: selected.request.mode,
      });
      routed.set(model, {
        rawConfig,
        config: routeConfig(rawConfig, route, ctx.facts),
        route,
        gate: rawConfig.retired ? { kind: 'retired' } : routeGate(route, ctx),
      });
    }
    return routed;
  });
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
  return readProviderKeyStatuses(secrets, [...consulted]).pipe(
    Effect.map((consultedStatuses) => ({
      ...ctx,
      keyStatuses: { ...ctx.keyStatuses, ...consultedStatuses },
    })),
  );
}

/**
 * The user's picker choices as a delta over {@link DEFAULT_MODELS}, so a change
 * to the curated defaults reaches every user while a default they turned off
 * stays off and a model they turned on stays on.
 */
const ModelSelectionSchema = z.object({
  enabledExtras: z.array(z.string()).readonly(),
  disabledDefaults: z.array(z.string()).readonly(),
});
type ModelSelection = z.infer<typeof ModelSelectionSchema>;

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
    stored === undefined ? undefined : ModelSelectionSchema.safeParse(stored);
  return parsed?.success === false
    ? { selection: EMPTY_MODEL_SELECTION, invalid: parsed.error }
    : { selection: parsed?.data ?? EMPTY_MODEL_SELECTION };
}

const reportInvalid = (invalid: z.ZodError | undefined) =>
  invalid === undefined
    ? Effect.void
    : Effect.logWarning(
        `Invalid stored ${GlobalStateKey.MODEL_SELECTION}; showing the default models.`,
        z.prettifyError(invalid),
      );

/**
 * Retired models drop out here, so no startup pass sweeps persisted state.
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
  ].filter((model) => !modelConfig(model)?.retired);
}

/**
 * When every enabled extra has retired and every default is off, the picker
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
 * Two invariants: at least one model stays enabled, and a retired model is
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
  if (input.enabled && modelConfig(input.model)?.retired) {
    return Effect.fail(
      refuse(`Model "${input.model}" is retired and cannot be enabled.`),
    );
  }
  let invalid: z.ZodError | undefined;
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
 * One computation's resolved inputs: the host facts and key statuses, read
 * once, and the route each visible model was decided to take over them.
 *
 * This is the whole of the boundary between reading a host and computing
 * availability. {@link readModelAvailabilityInputs} is the only thing in this
 * module that touches a host; {@link modelVerdictsFrom} and
 * {@link modelUnavailableReasonFrom} are pure functions of this value, so a
 * caller awaits once and then finishes synchronously. It carries no store
 * reference, which is what makes that structural rather than a promise: the
 * finishers have nothing to read a host through.
 */
export interface ModelAvailabilityInputs {
  /** The host facts plus the key status of every provider the routes consult. */
  readonly context: ModelAvailabilityContext;
  /** Stage 1's decision per model, keyed by model. */
  readonly routed: RoutedModels;
  /** The models the rows are built for, in the order they are shown. */
  readonly visible: readonly string[];
}

/**
 * Read everything one availability computation runs over: the facts every
 * model shares, each model routed once, then one key-status read per provider
 * the routes consult. The module's only host call; every host read fails in
 * its typed channel ({@link ModelHostFactUnreadable}). `models`, when given,
 * is honored verbatim. Nothing is cached here: the editor's routes and the
 * sign-in state are read live by design.
 */
export const readModelAvailabilityInputs = Effect.fn(
  'readModelAvailabilityInputs',
)(function* (stores: ModelOptionStores, models?: readonly string[]) {
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
  const routed = yield* routeModels(visible, routeCtx);
  const context = yield* withConsultedKeyStatuses(
    stores.secrets,
    routed,
    routeCtx,
  );
  return { context, routed, visible } satisfies ModelAvailabilityInputs;
});

/**
 * One visible model's verdict: whether it can run now, and the route that
 * decided it. The registry does not describe an `unknown-model`. Each host
 * words a row from it (the app's `modelOptionsFrom`).
 */
export type ModelVerdict =
  | { readonly model: string; readonly availability: 'unknown-model' }
  | {
      readonly model: string;
      readonly availability: ModelAvailabilityKind;
      /** The registry config as published: what the model is. */
      readonly published: ModelConfig;
      /** The config it runs with on its route: the editor's when Copilot serves it. */
      readonly config: ModelConfig;
      readonly route: ModelRoute<CopilotModelRoute>;
      /** The key its route bills, or the model's own source. */
      readonly source: string;
      /** The user's saved reasoning effort for it. */
      readonly savedEffort: ReasoningEffort | undefined;
    };

/**
 * Every visible model's verdict, in the order they are shown: pure, and the
 * whole of the per-model work, so the ~157-model settings pass costs no
 * awaits.
 */
export function modelVerdictsFrom(
  inputs: ModelAvailabilityInputs,
): ModelVerdict[] {
  return inputs.visible.map((model) => {
    const decision = inputs.routed.get(model);
    if (!decision) return { model, availability: 'unknown-model' };
    const { route } = decision;
    const config =
      route.kind === 'copilot' && route.route?.access === 'allowed'
        ? route.route.effectiveConfig
        : decision.config;
    return {
      model,
      availability: resolveModelAvailability(
        model,
        decision.gate,
        inputs.context.keyStatuses,
      ).kind,
      published: decision.rawConfig,
      config,
      route,
      source: modelSource(route, config),
      savedEffort: inputs.context.reasoningLevels[config.ref],
    };
  });
}

/**
 * The subscription the picker decided will pay for `model`'s next request, or
 * `undefined` when the user's own key would: the one prospective route. Pure,
 * like {@link modelUnavailableReasonFrom}; `inputs` must cover `model`.
 */
export function usageRouteFrom(
  inputs: ModelAvailabilityInputs,
  model: string,
): UsageRoute | undefined {
  const decision = inputs.routed.get(model);
  return decision
    ? resolveModelAvailability(model, decision.gate, inputs.context.keyStatuses)
        .usageRoute
    : undefined;
}

/** {@link usageRouteFrom} for one model, read fresh. */
export const readProspectiveUsageRoute = Effect.fn('readProspectiveUsageRoute')(
  function* (stores: ModelOptionStores, model: string) {
    return usageRouteFrom(
      yield* readModelAvailabilityInputs(stores, [model]),
      model,
    );
  },
);

/**
 * A human-readable reason why a model is unavailable, or `null` if available.
 * Pure — including the two Copilot kinds, whose sentence is worded from the
 * route the model was decided onto. `inputs` must have been read for a list
 * containing `model` (a single `[model]` list is the usual one).
 */
export function modelUnavailableReasonFrom(
  inputs: ModelAvailabilityInputs,
  model: string,
): string | null {
  const decision = inputs.routed.get(model);
  if (!decision) return `Model "${model}" is not recognized.`;

  const availability = resolveModelAvailability(
    model,
    decision.gate,
    inputs.context.keyStatuses,
  );
  if (MODEL_AVAILABILITY_STATUS[availability.kind].available) return null;

  // `availability.kind` is guaranteed `available: false` here, so it's a
  // valid `UnavailableAvailabilityKind` and every case is covered by
  // `UNAVAILABLE_REASON_BUILDERS` — the compiler, not this call site, is what
  // enforces that a newly added unavailable kind gets a reason.
  const kind = availability.kind as UnavailableAvailabilityKind;
  return UNAVAILABLE_REASON_BUILDERS[kind]({
    model,
    source: modelSource(decision.route, decision.config),
    route: decision.route,
  });
}

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
      !config.retired &&
      !config.deprecated &&
      decideModelRoute(config, {
        ...facts,
        validation: false,
        prefersCopilot: false,
        copilotRoute: undefined,
      }).kind === 'chatgpt-subscription'
    ) {
      models.add(model);
    }
  }
  return [...models];
}
