/**
 * A decided route made into a `BoundModel`: the canned validation model, or
 * a wire model `@texra-ai/llm` binds
 * with the route's one credential and the vendor knobs the settings hold.
 * Also the facts the run reads beside the `Model`: the config it runs and
 * bills with (the media its route carries included), the retry gate's
 * routes, and how each turn is delivered.
 */
import { hash } from 'node:crypto';

import { Effect, type Scope } from 'effect';
import {
  type ModelConfig,
  type ModelOrigin,
  type ReasoningRequest,
  routeConfig,
} from '@texra-ai/llm';
import { bindModel as bindWireModel } from '@texra-ai/llm/node';

import { validationModel } from '@agent/runtime/run/validationModel';
import { RouteUnavailable } from '@common/errors/agentErrors';
import {
  decideReasoning,
  PROTOCOL_BY_BACKEND,
  reasoningRouteOf,
} from '@model/reasoningLevel';
import type { ModelOptionStores } from '@model/computeModelOptions';
import {
  readBackgroundToggles,
  type BackgroundToggles,
  type ModelSettings,
} from '@model/modelSettings';
import { modelFetch } from '@platform/defaults/longRunningModelTransport';
import type { ModelBackend } from '@shared/schemas';

import { routeCredential, usageRouteOf } from './credentials';
import { routePolicies, type CallFailure } from './failureInfo';
import type { RouteDecision } from './routeDecision';
import type { BindRequest, BoundModel } from './ModelAccess';
import type { HttpClient } from 'effect/http';

/** Tool-use runs keep output headroom for context growth. */
const TOOL_USE_MAX_OUTPUT_FACTOR = 0.5;

/** What a binding carries out: the request, as decided over one settings read. */
export interface BindPlan {
  readonly request: BindRequest;
  /** The catalog config under the user's short-name preference. */
  readonly requested: ModelConfig;
  /** The effort, thinking and mode the model string asks for. */
  readonly ask: ReasoningRequest;
  readonly settings: ModelSettings;
  readonly decision: RouteDecision;
  /** The run's backend: a resumed run's, else the decided one. */
  readonly backend: ModelBackend;
}

/**
 * How a turn on a binding is delivered: as background work when the binding
 * can, the turn is text-only and its provider's toggle is on. The toggles are
 * read live each turn, so a flip mid-run applies to the next one (#12710).
 */
function backgroundOn(
  toggles: BackgroundToggles,
  turn: {
    readonly protocol: ModelOrigin['protocol'];
    readonly textOnly: boolean;
  },
): boolean {
  if (!turn.textOnly) return false;
  return turn.protocol === 'google-interactions'
    ? toggles.googleInteractions
    : toggles.responses;
}

/** A binding that never runs background work. */
const FOREGROUND = Effect.succeed('foreground' as const);

/**
 * The reasoning `config` asks for on `plan`'s route, its substitution logged.
 * The model options decide it with the same inputs (`routeReasoningOf`), so
 * a picker shows what this sends.
 */
const reasoningOf = Effect.fn('binding.reasoning')(function* (
  plan: BindPlan,
  config: ModelConfig,
) {
  const choice = yield* decideReasoning(
    config,
    plan.ask,
    plan.settings.reasoningLevels[config.ref],
    reasoningRouteOf(plan.decision.route, plan.backend),
  ).pipe(Effect.mapError(RouteUnavailable.of));
  if (choice.note !== undefined) yield* Effect.logInfo(choice.note);
  return choice;
});

/** What every binding of `plan` shares. */
const commonOf = ({ request, backend, settings }: BindPlan) => ({
  modelId: request.modelId,
  backend,
  automaticRetries: settings.automaticRetries,
  textOnly: request.textOnly,
});

/** Bind `plan`'s decided route into the caller's scope. */
export const bindRoute = Effect.fn('bindRoute')(function* (
  plan: BindPlan,
  stores: ModelOptionStores,
): Effect.fn.Return<
  BoundModel,
  CallFailure,
  Scope.Scope | HttpClient.HttpClient
> {
  const { request, requested, settings, backend } = plan;
  const { route, facts } = plan.decision;
  const protocol = PROTOCOL_BY_BACKEND[backend];
  if (protocol === 'validation') {
    const bound = validationModel(requested);
    yield* reasoningOf(plan, requested);
    return {
      ...commonOf(plan),
      // The canned model reads text only.
      config: {
        ...requested,
        capabilities: {
          ...requested.capabilities,
          supportsVision: false,
          supportsNativePdf: false,
          supportsNativeAudio: false,
        },
      },
      model: bound.model,
      origin: bound.origin,
      route: { kind: 'validation' },
      forcedToolChoice: true,
      persistentConnection: false,
      billing: {},
      routes: routePolicies([requested.provider, 'validation'], requested.id),
      delivery: FOREGROUND,
    };
  }
  if (route.kind === 'validation') {
    return yield* new RouteUnavailable({
      reason: 'unavailable',
      message: `Model ${request.modelId} routes through ${route.kind}, which the run's ${backend} backend cannot bind.`,
    });
  }
  const config = routeConfig(requested, route, facts);
  const credential = yield* routeCredential(
    route,
    config,
    facts,
    stores.secrets,
    request.rejected,
  );
  const codex = credential.route === 'chatgpt-subscription';
  const reasoning = yield* reasoningOf(plan, config);
  const turn = { protocol, textOnly: request.textOnly };
  const bound = yield* bindWireModel({
    protocol,
    model: config,
    endpoint: credential.endpoint,
    credentialScope: `${credential.provider}:${credential.route}`,
    // A subscription token is the bearer where an API key would be; the
    // Codex session also names its account.
    credential: codex
      ? {
          kind: 'codex',
          accessToken: credential.bearer,
          accountId: credential.accountId,
        }
      : { kind: 'api-key', apiKey: credential.bearer },
    billing: usageRouteOf(route),
    options: {
      maxOutputTokens: request.textOnly
        ? config.maxOutputTokens
        : Math.max(
            1,
            Math.floor(config.maxOutputTokens * TOOL_USE_MAX_OUTPUT_FACTOR),
          ),
      temperature: request.temperature,
      reasoning,
      ...settings.wire,
      // Background delivery, where the binding can carry it, wins over the
      // persistent WebSocket.
      background: backgroundOn(settings.background, turn),
      fetch: yield* modelFetch,
    },
  });
  return {
    ...commonOf(plan),
    config,
    model: bound.model,
    origin: bound.origin,
    route,
    forcedToolChoice: bound.forcedToolChoice,
    persistentConnection: bound.persistentConnection,
    ...(credential.route === 'chatgpt-subscription' ||
    credential.route === 'xai-subscription'
      ? { subscriptionToken: credential.bearer }
      : {}),
    billing: {
      ...(bound.serviceTier === 'fast' && { serviceTier: 'fast' as const }),
      ...(codex && credential.plan ? { plan: credential.plan } : {}),
    },
    routes: routePolicies(
      [
        config.provider,
        credential.route,
        credential.endpoint,
        hash(
          'sha256',
          `${credential.route}\0${credential.bearer}`,
          'base64url',
        ),
      ],
      config.id,
    ),
    delivery: bound.background
      ? Effect.map(readBackgroundToggles(stores), (toggles) =>
          backgroundOn(toggles, turn) ? 'background' : 'foreground',
        )
      : FOREGROUND,
  };
});
