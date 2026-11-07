/**
 * A decided route made into a `BoundModel`: the canned validation model, or
 * a wire model `@texra-ai/llm` binds
 * with the route's one credential and the vendor knobs the settings hold.
 * Also the facts the run reads beside the `Model`: the config it runs and
 * bills with (the media its route carries included), the retry gate's
 * routes, and how each turn is delivered.
 */
import { hash } from 'node:crypto';

import { Effect, Option, type Scope } from 'effect';
import {
  type ModelConfig,
  type ModelOrigin,
  type ReasoningRequest,
} from '@texra-ai/llm';
import { bindModel as bindWireModel } from '@texra-ai/llm/node';

import { RouteUnavailable } from '@common/errors/agentErrors';
import { decideReasoning, PROTOCOL_BY_BACKEND } from '@model/reasoningLevel';
import type { ModelSettings } from '@model/modelSettings';
import { runModelFetch } from '@platform/defaults/longRunningModelTransport';
import type { Secrets } from '@platform/secrets';
import type { SubscriptionAccounts } from '@texra-ai/llm/node';

import { routeCredential } from './credentials';
import { routePolicies, type CallFailure } from './failureInfo';
import { ValidationModel, type RouteDecision } from './routeDecision';
import type { BindRequest, BoundModel } from './ModelAccess';
import type { HttpClient } from 'effect/http';

/** Tool-use runs keep output headroom for context growth. */
const TOOL_USE_MAX_OUTPUT_FACTOR = 0.5;

/** What a binding carries out: the request, as decided over one settings read. */
interface BindPlan {
  readonly request: BindRequest;
  /** The catalog config, or the route overlay the request keeps. */
  readonly requested: ModelConfig;
  /** The effort, thinking and mode the model string asks for. */
  readonly ask: ReasoningRequest;
  readonly settings: ModelSettings;
  readonly decision: RouteDecision;
}

/**
 * Whether a binding's turns go out as background work: when the binding can
 * and its turns are text-only, and on Google only while its toggle is on.
 * Decided once, at bind: a toggle flipped mid-run applies at the next bind.
 */
function backgroundOn(
  googleBackground: boolean,
  turn: {
    readonly protocol: ModelOrigin['protocol'];
    readonly textOnly: boolean;
  },
): boolean {
  if (!turn.textOnly) return false;
  return turn.protocol !== 'google-interactions' || googleBackground;
}

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
    plan.decision.route,
  ).pipe(Effect.mapError(RouteUnavailable.of));
  if (choice.note !== undefined) yield* Effect.logInfo(choice.note);
  return choice;
});

/** What every binding of `plan` shares. */
const commonOf = ({ request, decision, settings }: BindPlan) => ({
  modelId: request.modelId,
  backend: decision.backend,
  declinedRoutes: request.declinedRoutes,
  automaticRetries: settings.automaticRetries,
  textOnly: request.textOnly,
});

/** Bind `plan`'s decided route into the caller's scope. */
export const bindRoute = Effect.fn('bindRoute')(function* (
  plan: BindPlan,
): Effect.fn.Return<
  BoundModel,
  CallFailure,
  Scope.Scope | HttpClient.HttpClient | Secrets | SubscriptionAccounts
> {
  const { request, requested, settings } = plan;
  const { route, backend } = plan.decision;
  const protocol = PROTOCOL_BY_BACKEND[backend];
  if (protocol === 'validation') {
    const canned = yield* Effect.serviceOption(ValidationModel);
    if (Option.isNone(canned)) {
      return yield* new RouteUnavailable({
        message: `Model ${request.modelId} runs on the validation model, which this build does not carry.`,
      });
    }
    yield* reasoningOf(plan, requested);
    return {
      ...commonOf(plan),
      ...canned.value.bind(requested),
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
      billing: 'api-key',
      maxOutputTokens: requested.maxOutputTokens,
      background: false,
      serviceTier: null,
      forcedToolChoice: true,
      route: { kind: 'validation' },
      routes: routePolicies([requested.provider, 'validation'], requested.id),
    };
  }
  if (route.kind === 'validation') {
    return yield* new RouteUnavailable({
      message: `Model ${request.modelId} routes through ${route.kind}, which the run's ${backend} backend cannot bind.`,
    });
  }
  if (route.kind === 'no-api-key') {
    return yield* new RouteUnavailable({
      message: `Model "${requested.label}" has no direct API-key provider.`,
    });
  }
  const credential = yield* routeCredential(route);
  const chatgpt = credential.route === 'chatgpt-subscription';
  const reasoning = yield* reasoningOf(plan, requested);
  const turn = { protocol, textOnly: request.textOnly };
  const bound = yield* bindWireModel({
    model: requested,
    route,
    // A subscription token is the bearer where an API key would be; the
    // ChatGPT plan's also selects that plan's request rules.
    credential: chatgpt
      ? { kind: 'chatgpt', accessToken: credential.bearer }
      : { kind: 'api-key', apiKey: credential.bearer },
    options: {
      maxOutputTokens: request.textOnly
        ? requested.maxOutputTokens
        : Math.max(
            1,
            Math.floor(requested.maxOutputTokens * TOOL_USE_MAX_OUTPUT_FACTOR),
          ),
      temperature: request.temperature,
      reasoning,
      ...settings.wire,
      // Background delivery, where the binding can carry it, wins over the
      // persistent WebSocket.
      background: backgroundOn(settings.googleBackground, turn),
      fetch: yield* runModelFetch,
    },
  });
  return {
    ...commonOf(plan),
    ...bound,
    route,
    ...(chatgpt && credential.plan ? { plan: credential.plan } : {}),
    routes: routePolicies(
      [
        bound.config.provider,
        credential.route,
        route.endpoint,
        // A key cools its own route; a session is one per signed-in
        // account, whose token rotates under it.
        typeof credential.bearer === 'string'
          ? hash(
              'sha256',
              `${credential.route}\0${credential.bearer}`,
              'base64url',
            )
          : 'session',
      ],
      bound.config.id,
    ),
  };
});
