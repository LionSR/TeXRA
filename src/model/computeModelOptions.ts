import { Data, Effect } from 'effect';
import { MODEL_CONFIGS, type ModelConfig, type ReasoningEffort } from 'llm-zoo';
import { z } from 'zod';

import {
  isCodexSignedIn,
  isPreferCodexSubscription,
} from '@model/codex/codexSubscription';
import {
  isPreferXaiSubscription,
  isXaiSignedIn,
} from '@model/xai/xaiSubscription';
import { createLog } from '@logger/logUtils';
import { StateWriteFailed } from '@platform/interfaces';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  MODEL_AVAILABILITY_STATUS,
  REASONING_LEVEL_LABELS,
  type ModelAvailabilityKind,
  type ModelOptionData,
} from '@shared/schemas';
import {
  DEFAULT_HELPER_MODEL,
  providerDisplayName,
} from '@shared/constants/providers';
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
} from '@shared/model/kimiCodeRetryGate';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  getPreferKimiCode,
  getUseOpenRouter,
} from '@utils/config/providerConfig';

import { hasUsableApiKey, type ApiProvider } from './apiProviders';
import {
  reasoningEffortOverrides,
  supportsReasoningLevel,
} from './reasoningLevel';
import {
  resolveCodexSubscriptionCapabilities,
  resolveXaiSubscriptionCapabilities,
  type ProviderCapabilityProfile,
} from './providerCapabilities';
import {
  kimiCodeEffectiveConfig,
  type KimiCodeRoutingFacts,
} from './kimiCodeSubscriptionRouting';
import { resolveEffectiveHelperModel } from './helperModelSelection';
import {
  buildBaseModelOption,
  DEFAULT_MODELS,
  isRetiredModel,
} from './modelOptionsBasic';
import {
  isOpenRouterRoutingUnsupported,
  resolveDirectModelApiKeyProvider,
  resolveModelSource,
  shouldRouteModelThroughOpenRouter,
} from './openRouterRouting';
import {
  copilotRouteUnavailableReason,
  prefersCopilotRoute,
} from './copilotRouting';
import {
  discoveredCopilotRoutes,
  getRuntimeModelConfig,
  copilotRouteForModel,
} from './runtimeModelRegistry';

const log = createLog('computeModelOptions');

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

/**
 * Module-private refinement of an unavailable {@link ModelAvailabilityKind},
 * recorded by the branch that chose the kind so the reason builder never has
 * to re-derive that branch's condition. Deliberately not part of the
 * `ModelAvailabilityKind` wire enum: renderers and the CLI treat an OpenRouter
 * key gap exactly like any other missing key, and widening the wire enum would
 * force every host's mapping to grow a case for a distinction only the prose
 * cares about.
 */
type UnavailableReason = 'openrouter-missing-key';

/**
 * A resolved verdict: the kind the row ships, plus the refinements this
 * module's later steps read. What the kind *means* is
 * {@link MODEL_AVAILABILITY_STATUS}, not a field copied onto every row.
 *
 * The two Copilot fields are what makes the later steps pure: both are read
 * off the live Copilot preference and route catalogue by the branch that chose
 * the kind, so nothing after the route ladder consults either again.
 */
interface ModelAvailabilityStatus {
  kind: ModelAvailabilityKind;
  providerCapabilities?: ProviderCapabilityProfile;
  reason?: UnavailableReason;
  /** The discovered route's config, on `copilot-allowed` only. */
  copilotConfig?: ModelConfig;
  /** The dispatch path's own wording, on the two unavailable Copilot kinds. */
  copilotReason?: string;
}

function availabilityStatus(
  kind: ModelAvailabilityKind,
): ModelAvailabilityStatus {
  return { kind };
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
  readonly config: ModelConfig;
  readonly reason: UnavailableReason | undefined;
  /** The Copilot wording captured when this model was routed, if it took that branch. */
  readonly copilotReason: string | undefined;
}

/**
 * Unavailable reason for both Copilot kinds; see the comment at its use sites
 * in {@link UNAVAILABLE_REASON_BUILDERS}.
 */
function copilotUnavailableReason({
  model,
  copilotReason,
}: UnavailableReasonContext): string {
  return (
    copilotReason ??
    `Model "${model}" is currently unavailable through Copilot in VS Code.`
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
  'missing-key': ({ model, config, reason }) => {
    if (reason === 'openrouter-missing-key') {
      return `Model "${model}" requires an OpenRouter API key.`;
    }
    const modelSource = resolveModelSource(config) ?? config.provider;
    const providerName = providerDisplayName(modelSource);
    return `Model "${model}" requires your ${providerName} API key. Provide it to continue.`;
  },
  // Both Copilot arms ship the dispatch path's own wording
  // ({@link copilotRouteUnavailableReason}), captured when the model was
  // routed, so the picker shows exactly the sentence a run would fail with.
  // The `??` arm is unreachable: these kinds are only chosen inside the
  // `prefersCopilotRoute` branch, which is the one case that helper never
  // answers `undefined` for.
  'copilot-consent-required': copilotUnavailableReason,
  'copilot-unavailable': copilotUnavailableReason,
  // Unreachable from `modelUnavailableReasonFrom` today (it returns its own
  // "not recognized" message before a config resolves far enough to compute
  // availability at all), but the table must still cover it: `unknown-model`
  // is `available: false`, so leaving it out would defeat the whole point of
  // this table being compiler-checked.
  'unknown-model': ({ model }) => `Model "${model}" is not recognized.`,
};

/**
 * Ship the resolved verdict on the option row: the kind alone, which
 * `MODEL_AVAILABILITY_STATUS` words for whichever surface renders it.
 */
function withAvailabilityFields(
  option: ModelOptionData,
  availability: ModelAvailabilityStatus,
): ModelOptionData {
  return { ...option, availability: availability.kind };
}

/**
 * Which providers have a usable API key, as plain data — the only provider-key
 * fact the per-model pass reads. Stage 0 fills the two routing providers
 * (`openRouter`, `kimiCode`); stage 2 fills the providers the route ladder
 * said it would consult. A provider absent from the map was never read, which
 * the verdict treats as a defect rather than as an absent key.
 */
type ProviderKeyStatuses = Partial<Record<ApiProvider, boolean>>;

/**
 * The host facts the route ladder reads, all resolved once before any model is
 * routed. It deliberately excludes {@link ProviderKeyStatuses}: the ladder runs
 * *before* the per-provider key statuses are read — that pass is how the batch
 * read learns which providers to consult — so the compiler, not a comment,
 * keeps the ladder key-independent.
 */
interface ModelRouteContext {
  reasoningLevels: Readonly<Record<string, ReasoningEffort>>;
  hasOpenRouter: boolean;
  useOpenRouter: boolean;
  /** Whether the user is signed in with ChatGPT (only resolved when the
   * "prefer subscription" switch is on). */
  codexSignedIn: boolean;
  /** Whether the user is signed in with Grok (only when prefer is on). */
  xaiSignedIn: boolean;
  /**
   * The Kimi Code route facts in their canonical shape, so this module feeds
   * the shared resolver ({@link kimiCodeEffectiveConfig}) the same assembly
   * `modelRoutes` uses instead of a hand-renamed copy.
   */
  kimiRouting: KimiCodeRoutingFacts;
}

/** The route facts plus the key statuses the batch read resolved for them. */
interface ModelAvailabilityContext extends ModelRouteContext {
  keyStatuses: ProviderKeyStatuses;
}

/** The one provider whose key decides a model the ladder did not settle. */
interface ProviderKeyGate {
  needsProviderKey: ApiProvider;
}

/** The ladder's answer for one model: a verdict, or the provider still to consult. */
type ModelRoute = ModelAvailabilityStatus | ProviderKeyGate;

/**
 * What stage 1 decided for one model, and the only thing stage 3 reads about
 * it. Both configs are kept because the row needs both: the route and the
 * option are built from the effective config, while the route label asks the
 * registry config whether the model is Kimi-subscription eligible.
 */
interface RoutedModel {
  /** The registry config as published. */
  readonly rawConfig: ModelConfig;
  /** The config the model routes and runs with (Kimi Code synthesis applied). */
  readonly config: ModelConfig;
  readonly route: ModelRoute;
}

/**
 * Stage 1's decisions, keyed by model. A visible model absent from the map is
 * one the registry does not describe; nothing else is missing from it.
 */
type RoutedModels = ReadonlyMap<string, RoutedModel>;

/**
 * Stage 1 — the route ladder, free of any key status. Every branch that can
 * decide availability from the stage-0 facts answers with its kind; a model
 * that comes down to a direct provider key answers with that provider instead,
 * so the batch read that follows consults exactly the providers the ladder
 * reached and no others.
 *
 * This is the one step that reads the Copilot preference and route catalogue,
 * and it takes everything it finds there with it — the route's config, or the
 * sentence an unavailable route is explained with — so no later step has to go
 * back to either.
 */
function resolveModelRoute(
  stores: ModelOptionStores,
  model: string,
  config: ModelConfig,
  ctx: ModelRouteContext,
): ModelRoute {
  const globalState: Pick<StateStore, 'get'> = stores.globalState;
  if (config.retired) {
    return availabilityStatus('retired');
  }

  // An explicit Copilot route preference reports the discovered route's own
  // state — consent and temporary unavailability are route states on the one
  // canonical model row, never a reason to fall back to another transport.
  if (prefersCopilotRoute(model, globalState)) {
    const route = copilotRouteForModel(model);
    // No discovered route is the same verdict as a discovered unavailable one.
    // The kind is the access word itself, so there is nothing to translate.
    const access = route?.access ?? 'unavailable';
    if (access === 'allowed') {
      return {
        ...availabilityStatus('copilot-allowed'),
        copilotConfig: route?.effectiveConfig,
      };
    }
    return {
      ...availabilityStatus(`copilot-${access}`),
      // The dispatch path's own wording for this model, resolved here from the
      // same preference and catalogue this decision was made on.
      copilotReason: copilotRouteUnavailableReason(model, globalState),
    };
  }

  if (isOpenRouterRoutingUnsupported(config, ctx.useOpenRouter)) {
    return availabilityStatus('provider-unavailable');
  }

  // ChatGPT subscription (Codex) is a preference, not a hard requirement. When
  // the host is not signed in, continue through the normal API-key paths
  // so the switch cannot disable models that are otherwise runnable.
  if (ctx.codexSignedIn) {
    const subscriptionCapabilities = resolveCodexSubscriptionCapabilities(
      stores,
      config,
      ctx.useOpenRouter,
    );
    if (subscriptionCapabilities) {
      return {
        ...availabilityStatus('subscription-access'),
        providerCapabilities: subscriptionCapabilities,
      };
    }
  }

  // Grok (xAI) subscription — same preference pattern as ChatGPT, and its own
  // kind so pickers and status rows do not say "ChatGPT subscription" for an
  // xAI model.
  if (ctx.xaiSignedIn) {
    const subscriptionCapabilities = resolveXaiSubscriptionCapabilities(
      stores,
      config,
      ctx.useOpenRouter,
    );
    if (subscriptionCapabilities) {
      return {
        ...availabilityStatus('xai-subscription-access'),
        providerCapabilities: subscriptionCapabilities,
      };
    }
  }

  // A configured OpenRouter key is the only ready state for these calls.
  if (shouldRouteModelThroughOpenRouter(config, ctx.useOpenRouter)) {
    if (ctx.hasOpenRouter) return availabilityStatus('openrouter-key');
    return {
      ...availabilityStatus('missing-key'),
      reason: 'openrouter-missing-key',
    };
  }

  // Dispatch sends every remaining request to the direct provider, so only its
  // key makes the model ready. The live-route branch above is the only source
  // of 'openrouter-key'.
  const provider = resolveDirectModelApiKeyProvider(config);
  if (!provider) return availabilityStatus('missing-key');
  return { needsProviderKey: provider };
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
  route: ModelRoute,
  keyStatuses: ProviderKeyStatuses,
): ModelAvailabilityStatus {
  if (!('needsProviderKey' in route)) return route;
  const provider = route.needsProviderKey;
  const usable = keyStatuses[provider];
  if (usable === undefined) {
    throw new Error(
      `Model "${model}" routes to the "${provider}" API key, but that provider's key status was never read. A route decision reached the verdict without passing through the batch read.`,
    );
  }
  return availabilityStatus(usable ? 'provider-key' : 'missing-key');
}

/**
 * A host fact this module reads synchronously — a workspace preference, a
 * config switch, a stored state entry — could not be read at all, because the
 * host's config or state store threw. That is environmental, not a bug in this
 * module, so it belongs in the typed failure channel rather than as a defect:
 * a caller that already degrades on an unreadable host (the delegation
 * annotation skips its "Available models:" line and logs) recovers from it
 * exactly as it recovers from an unreadable secret store, and a caller that
 * runs this program at its boundary gets the rejection the async wrapper used
 * to give it.
 *
 * The module's own invariant — a verdict reached for a provider whose key
 * status was never read ({@link resolveModelAvailability}) — stays a defect:
 * it can only be a programming error here, and no caller should paper over it.
 */
export class ModelHostFactUnreadable extends Data.TaggedError(
  'ModelHostFactUnreadable',
)<{
  readonly fact: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The one wrap of this module's synchronous host reads. */
const hostFact = <A>(
  fact: string,
  read: () => A,
): Effect.Effect<A, ModelHostFactUnreadable> =>
  Effect.try({
    try: read,
    catch: (cause) =>
      new ModelHostFactUnreadable({
        fact,
        message: `Could not read ${fact} from the host.`,
        cause,
      }),
  });

/**
 * One key status per provider, read once. A failed read degrades that provider
 * to unavailable and warns once for the provider, never once per model that
 * consults it (#11508), so one unreadable store cannot flood the log.
 */
function readProviderKeyStatuses(
  secrets: PlatformSecrets,
  providers: readonly ApiProvider[],
): Effect.Effect<ProviderKeyStatuses> {
  return Effect.forEach(
    providers,
    (provider) =>
      hasUsableApiKey(secrets, provider).pipe(
        Effect.catchTag('SecretsFailed', (failure) =>
          Effect.sync(() => {
            log.warn(
              `Failed to read ${providerDisplayName(provider)} API key status; treating it as unavailable.`,
              { data: failure.cause },
            );
            return false;
          }),
        ),
        Effect.map((usable) => [provider, usable] as const),
      ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

/**
 * Stage 0 — every host fact the ladder reads, resolved once per call. The two
 * routing key statuses belong here rather than in the stage-2 batch because
 * routing itself depends on them: `kimiCodeEffectiveConfig` reads `keySet`,
 * and the OpenRouter branch is decided by the OpenRouter key alone.
 */
function buildAvailabilityContext(
  stores: ModelOptionStores,
): Effect.Effect<ModelAvailabilityContext, ModelHostFactUnreadable> {
  return Effect.gen(function* () {
    const { secrets, globalState } = stores;
    // The switches and stored levels, read before anything is probed: the two
    // "prefer my subscription" answers decide whether their probe runs at all.
    const [
      useOpenRouter,
      preferCodexSubscription,
      preferXaiSubscription,
      preferKimiCode,
      reasoningLevels,
    ] = yield* Effect.all([
      hostFact('the OpenRouter switch', () => getUseOpenRouter(stores)),
      hostFact('the ChatGPT subscription preference', () =>
        isPreferCodexSubscription(stores),
      ),
      hostFact('the Grok subscription preference', () =>
        isPreferXaiSubscription(stores),
      ),
      hostFact('the Kimi Code routing preference', () =>
        getPreferKimiCode(stores),
      ),
      hostFact('the stored reasoning levels', () =>
        reasoningEffortOverrides(globalState),
      ),
    ] as const);
    const [routingKeys, codexSignedIn, xaiSignedIn] = yield* Effect.all(
      [
        readProviderKeyStatuses(secrets, ['openRouter', 'kimiCode']),
        // Only worth a probe when the "prefer subscription" switch is on.
        preferCodexSubscription ? isCodexSignedIn() : Effect.succeed(false),
        preferXaiSubscription ? isXaiSignedIn() : Effect.succeed(false),
      ] as const,
      { concurrency: 'unbounded' },
    );
    return {
      reasoningLevels,
      keyStatuses: routingKeys,
      hasOpenRouter: routingKeys.openRouter === true,
      useOpenRouter,
      codexSignedIn,
      xaiSignedIn,
      kimiRouting: {
        useOpenRouter,
        keySet: routingKeys.kimiCode === true,
        preferKimiCode,
      },
    };
  });
}

/**
 * Stage 1 — route every model once, and keep the decision. Each of the
 * ladder's live inputs (the runtime registry, the Copilot preference in global
 * state, the stage-0 facts) is therefore read once per computation: stage 3
 * finishes these decisions rather than re-running the ladder over inputs that
 * may have moved while the key read was in flight.
 */
function routeModels(
  stores: ModelOptionStores,
  models: readonly string[],
  ctx: ModelRouteContext,
): RoutedModels {
  const routed = new Map<string, RoutedModel>();
  for (const model of models) {
    if (routed.has(model)) continue;
    const rawConfig = getRuntimeModelConfig(model);
    if (!rawConfig) continue;
    // Mirror modelRoutes: a dual-backend Kimi model routed to the coding
    // endpoint runs with the synthesized runtime config, so the row reflects it.
    const config = kimiCodeEffectiveConfig(rawConfig, ctx.kimiRouting);
    routed.set(model, {
      rawConfig,
      config,
      route: resolveModelRoute(stores, model, config, ctx),
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
  const consulted = new Set<ApiProvider>();
  for (const { route } of routed.values()) {
    if (
      'needsProviderKey' in route &&
      ctx.keyStatuses[route.needsProviderKey] === undefined
    ) {
      consulted.add(route.needsProviderKey);
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
 * An unreadable stored selection is reported and read as the empty delta —
 * the defaults — without being rewritten: the next picker toggle re-encodes a
 * valid delta from the list shown.
 */
function readModelSelection(state: Pick<StateStore, 'get'>): ModelSelection {
  const stored = state.get<unknown>(GlobalStateKey.MODEL_SELECTION);
  if (stored === undefined) return EMPTY_MODEL_SELECTION;
  const parsed = ModelSelectionSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  log.warn(
    `Invalid stored ${GlobalStateKey.MODEL_SELECTION}; showing the default models.`,
    { data: z.prettifyError(parsed.error) },
  );
  return EMPTY_MODEL_SELECTION;
}

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
  ].filter((model) => !isRetiredModel(model));
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
export function getEnabledModels(
  state: Pick<StateStore, 'get'>,
): readonly string[] {
  return enabledOrDefaults(readModelSelection(state));
}

/**
 * Enable or disable one model — the only writer of
 * `GlobalStateKey.MODEL_SELECTION`.
 *
 * Two invariants: at least one model stays enabled, and a retired model is
 * never enabled. Throws on either violation; callers surface the message.
 */
export function setModelEnabled(input: {
  readonly model: string;
  readonly enabled: boolean;
  readonly state: StateStore;
}): Effect.Effect<readonly string[], StateWriteFailed> {
  const state = input.state;
  if (input.enabled && isRetiredModel(input.model)) {
    // The sibling refusal below is typed for the same reason: the guard runs
    // when the method is called, and a throw here would escape the channel
    // this signature declares.
    const message = `Model "${input.model}" is retired and cannot be enabled.`;
    return Effect.fail(
      new StateWriteFailed({
        key: GlobalStateKey.MODEL_SELECTION,
        message,
        cause: new Error(message),
      }),
    );
  }

  // Edit the list the picker shows — including the all-defaults fallback — and
  // re-encode the delta from it, so a write never acts on a hidden state. An
  // explicit enable is recorded in `enabledExtras` even for a default, so it
  // survives the model later leaving the curated defaults.
  const selection = readModelSelection(state);
  const current = enabledOrDefaults(selection);
  const others = current.filter((model) => model !== input.model);
  const toggled = input.enabled ? [...others, input.model] : others;
  const next: ModelSelection = {
    enabledExtras: [
      ...new Set([
        ...selection.enabledExtras.filter((model) => toggled.includes(model)),
        ...(input.enabled ? [input.model] : []),
      ]),
    ],
    disabledDefaults: DEFAULT_MODELS.filter(
      (model) => !toggled.includes(model),
    ),
  };
  const nextEnabled = enabledModelsOf(next);
  if (nextEnabled.length === 0) {
    // A refusal, not a defect: the caller is told in the channel its signature
    // declares, so a UI that disables the last model can surface it instead of
    // crashing the program that composed this.
    const message =
      'At least one model must stay enabled. Enable another model before disabling this one.';
    return Effect.fail(
      new StateWriteFailed({
        key: GlobalStateKey.MODEL_SELECTION,
        message,
        cause: new Error(message),
      }),
    );
  }
  // If the helper model was just removed, pin the built-in default. Do not
  // fall back to the first remaining picker model — that is a premium default,
  // not the cheap auxiliary.
  const pinsHelper =
    !input.enabled &&
    resolveEffectiveHelperModel(
      state.get<string | undefined>(GlobalStateKey.HELPER_MODEL),
      current,
    ) === input.model;

  return state
    .update(GlobalStateKey.MODEL_SELECTION, next)
    .pipe(
      Effect.andThen(
        pinsHelper
          ? state.update(GlobalStateKey.HELPER_MODEL, DEFAULT_HELPER_MODEL)
          : Effect.void,
      ),
      Effect.as(nextEnabled),
    );
}

/**
 * Build typed model option data for a single model from stage 1's decision for
 * it. No decision means the registry does not describe the model.
 */
function buildModelOptionData(
  model: string,
  decision: RoutedModel | undefined,
  ctx: ModelAvailabilityContext,
): ModelOptionData {
  if (!decision) {
    return withAvailabilityFields(
      { value: model, label: model },
      availabilityStatus('unknown-model'),
    );
  }
  const { rawConfig, config } = decision;

  const availability = resolveModelAvailability(
    model,
    decision.route,
    ctx.keyStatuses,
  );
  const optionConfig = availability.providerCapabilities
    ? {
        ...config,
        contextWindow: availability.providerCapabilities.contextWindow,
        inputPrice: availability.providerCapabilities.inputPrice,
        outputPrice: availability.providerCapabilities.outputPrice,
      }
    : (availability.copilotConfig ?? config);
  let reasoning: string | undefined;
  if (optionConfig.capabilities.supportsReasoning) {
    if (availability.kind === 'copilot-allowed') {
      reasoning = 'Default (provider managed)';
    } else {
      const defaultLevel =
        REASONING_LEVEL_LABELS[optionConfig.capabilities.reasoningEffort];
      if (supportsReasoningLevel(optionConfig)) {
        const effort = ctx.reasoningLevels[model];
        reasoning =
          effort === undefined
            ? `Default (${defaultLevel})`
            : REASONING_LEVEL_LABELS[effort];
      } else {
        reasoning = optionConfig.capabilities.supportsReasoningEffort
          ? `${defaultLevel} (fixed)`
          : 'Default';
      }
    }
  }
  let routeLabel: string | undefined;
  if (availability.kind === 'copilot-allowed') {
    // The row's identity stays the base model; the badge names the route.
    routeLabel = 'Via Copilot';
  } else if (
    isKimiSubscriptionEligible(rawConfig) &&
    !isKimiCodeExclusiveModel(rawConfig)
  ) {
    const via = shouldRouteModelThroughOpenRouter(config, ctx.useOpenRouter)
      ? 'OpenRouter'
      : providerDisplayName(resolveModelSource(config) ?? config.provider);
    routeLabel = `Via ${via}`;
  }
  return withAvailabilityFields(
    {
      ...buildBaseModelOption(model, optionConfig, config),
      ...(reasoning ? { reasoning } : {}),
      ...(routeLabel ? { routeLabel } : {}),
    },
    availability,
  );
}

/**
 * One computation's resolved inputs: the host facts and key statuses, read
 * once, and the route each visible model was decided to take over them.
 *
 * This is the whole of the boundary between reading a host and computing
 * availability. {@link readModelAvailabilityInputs} is the only thing in this
 * module that touches a host; {@link modelOptionsFrom} and
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
 * Read everything one availability computation runs over, in two steps: the
 * facts every model shares, then one key-status read per provider the visible
 * models actually consult, with each model routed once in between so that
 * batch consults exactly the providers the ladder reached.
 *
 * This is the module's only host call, and it is an Effect so that a caller
 * inside a program yields it instead of bridging a promise: the store read
 * behind it is interruptible and its failure is typed. Every host read it
 * makes fails in that channel, the synchronous preference and state reads
 * included ({@link ModelHostFactUnreadable}), so an unreadable host reaches a
 * caller as a failure it can recover from rather than as a defect.
 *
 * When `models` is provided the caller's view of the visible-models list is
 * honored verbatim. Nothing here is cached beyond the caches its reads already
 * own: the secret reads behind `hasUsableApiKey` in `apiProviders`
 * (`invalidateApiKeyCache`), the Copilot route catalogue in
 * `runtimeModelRegistry` (`invalidateRuntimeModelRegistry`), and the rest are
 * synchronous config and state reads plus the probe-backed sign-in status
 * (`isCodexSignedIn`, `isXaiSignedIn`, live by design), so there is no second
 * cache to keep fresh here.
 */
export const readModelAvailabilityInputs = Effect.fn(
  'readModelAvailabilityInputs',
)(function* (stores: ModelOptionStores, models?: readonly string[]) {
  // Presentation-only refresh: the catalogue keeps its last-known entries on
  // a discovery failure, so this step cannot fail (see `discoveredCopilotRoutes`).
  yield* discoveredCopilotRoutes();
  const routeCtx = yield* buildAvailabilityContext(stores);
  const visible =
    models ??
    visibleModelsForAccess(
      stores,
      yield* hostFact('the enabled-model selection', () =>
        getEnabledModels(stores.globalState),
      ),
      routeCtx,
    );
  // Stage 1 is computation over the stage-0 facts except for the one live
  // state read in its ladder, the Copilot route preference, so an unreadable
  // state store fails it the same way it fails the reads above.
  const routed = yield* hostFact('the Copilot route preference', () =>
    routeModels(stores, visible, routeCtx),
  );
  const context = yield* withConsultedKeyStatuses(
    stores.secrets,
    routed,
    routeCtx,
  );
  return { context, routed, visible } satisfies ModelAvailabilityInputs;
});

/**
 * Typed model option data for Lit-native rendering — pure, and the whole of
 * the per-model work, so the ~157-model settings pass costs no awaits.
 */
export function modelOptionsFrom(
  inputs: ModelAvailabilityInputs,
): ModelOptionData[] {
  return inputs.visible.map((model) =>
    buildModelOptionData(model, inputs.routed.get(model), inputs.context),
  );
}

/**
 * A human-readable reason why a model is unavailable, or `null` if available.
 * Pure — including the two Copilot kinds, whose sentence was worded when the
 * model was routed. `inputs` must have been read for a list containing `model`
 * (a single `[model]` list is the usual one).
 */
export function modelUnavailableReasonFrom(
  inputs: ModelAvailabilityInputs,
  model: string,
): string | null {
  const decision = inputs.routed.get(model);
  if (!decision) return `Model "${model}" is not recognized.`;

  const { config, route } = decision;
  const availability = resolveModelAvailability(
    model,
    route,
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
    config,
    reason: availability.reason,
    copilotReason: availability.copilotReason,
  });
}

function visibleModelsForAccess(
  stores: ModelOptionStores,
  configuredModels: readonly string[],
  context: ModelRouteContext,
): readonly string[] {
  const models = new Set(configuredModels);
  if (!context.codexSignedIn) return [...models];

  for (const [model, config] of Object.entries(MODEL_CONFIGS)) {
    if (
      !config.retired &&
      !config.deprecated &&
      resolveCodexSubscriptionCapabilities(
        stores,
        config,
        context.useOpenRouter,
      ) !== null
    ) {
      models.add(model);
    }
  }
  return [...models];
}
