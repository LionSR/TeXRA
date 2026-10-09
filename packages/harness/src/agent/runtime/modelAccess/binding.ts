/**
 * A decided route made into a `BoundModel`: the editor's model for a Copilot
 * route, the canned validation model, or a wire model `@texra-ai/llm` binds
 * with the route's one credential and the vendor knobs the settings hold.
 * Also the facts the run reads beside the `Model`: the config it runs and
 * bills with (the media its route carries included), the retry gate's
 * routes, and how each turn is delivered.
 */
import { hash } from 'node:crypto';

import { Effect, type Scope } from 'effect';
import {
  routeConfig,
  type ModelOrigin,
  type ReasoningRequest,
} from '@texra-ai/llm';
import { bindModel as bindWireModel } from '@texra-ai/llm/node';

import { validationModel } from '@agent/runtime/run/validationModel';
import { RouteUnavailable } from '@common/errors/agentErrors';
import { decideReasoning } from '@model/reasoningLevel';
import type { ModelOptionStores } from '@model/computeModelOptions';
import {
  readBackgroundToggles,
  type BackgroundToggles,
  type ModelSettings,
} from '@model/modelSettings';
import type { CopilotModelRoute } from '@model/copilotRouting';
import { modelFetch } from '@platform/defaults/longRunningModelTransport';
import { LanguageModel } from '@platform/languageModel';
import type { ModelBackend } from '@shared/schemas';

import { routeCredential } from './credentials';
import { PROTOCOL_BY_BACKEND, type RouteDecision } from './routeDecision';
import { routePolicies, type CallFailure } from './failureInfo';
import type { BindRequest, BoundModel } from './ModelAccess';
import type { ModelConfig } from 'llm-zoo';
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
    readonly modelName: string;
    readonly textOnly: boolean;
  },
): boolean {
  if (!turn.textOnly) return false;
  if (turn.protocol === 'google-interactions')
    return toggles.googleInteractions;
  return turn.modelName.toLowerCase().startsWith('gpt') && toggles.responses;
}

/** A binding that never runs background work. */
const FOREGROUND = Effect.succeed('foreground' as const);

/** The reasoning `config` asks for on `plan`'s route, its substitution logged. */
const reasoningOf = Effect.fn('binding.reasoning')(function* (
  plan: BindPlan,
  config: ModelConfig,
  codexSubscription: boolean,
) {
  const choice = yield* decideReasoning(
    config,
    plan.ask,
    plan.settings.reasoningLevels[config.ref],
    { protocol: PROTOCOL_BY_BACKEND[plan.backend], codexSubscription },
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

/**
 * The editor's model for a Copilot route, over the exact id, vendor and
 * version its discovery found. The editor manages its own reasoning and
 * context ceiling; the choice is recorded, not sent.
 */
const bindEditor = Effect.fn('binding.editor')(function* (
  plan: BindPlan,
  route: CopilotModelRoute,
): Effect.fn.Return<BoundModel, CallFailure, Scope.Scope | LanguageModel> {
  const routed = route.effectiveConfig;
  const requestedModel = route.reference.id;
  const deployment = { vendor: route.reference.vendor, version: route.version };
  // A choice the route cannot carry still fails the bind.
  yield* reasoningOf(plan, plan.requested, false);
  return {
    ...commonOf(plan),
    // The editor takes images only: no native PDF or audio input.
    config: {
      ...routed,
      capabilities: {
        ...routed.capabilities,
        supportsNativePdf: false,
        supportsNativeAudio: false,
      },
    },
    model: yield* (yield* LanguageModel).acquire({
      protocol: 'vscode-lm',
      requestedModel,
      deployment,
      supportsImageInput: routed.capabilities.supportsVision,
      supportsToolCalling: routed.capabilities.supportsFunctionCalling,
      defaults: { justification: 'Run the selected TeXRA agent.' },
    }),
    origin: {
      protocol: 'vscode-lm',
      codecVersion: 1,
      requestedModel,
      deployment,
    },
    route: { kind: 'copilot', route },
    forcedToolChoice: false,
    persistentConnection: false,
    billing: {},
    routes: routePolicies(
      ['vscode-lm', deployment.vendor, deployment.version],
      requestedModel,
    ),
    delivery: FOREGROUND,
  };
});

/** Bind `plan`'s decided route into the caller's scope. */
export const bindRoute = Effect.fn('bindRoute')(function* (
  plan: BindPlan,
  stores: ModelOptionStores,
): Effect.fn.Return<
  BoundModel,
  CallFailure,
  Scope.Scope | LanguageModel | HttpClient.HttpClient
> {
  const { request, requested, settings, backend } = plan;
  const { route, facts } = plan.decision;
  const protocol = PROTOCOL_BY_BACKEND[backend];
  if (protocol === 'vscode-lm' && route.kind === 'copilot')
    return yield* bindEditor(plan, route.route);
  if (protocol === 'validation') {
    const bound = validationModel(requested);
    yield* reasoningOf(plan, requested, false);
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
  if (
    protocol === 'vscode-lm' ||
    route.kind === 'copilot' ||
    route.kind === 'validation'
  ) {
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
    request.renew === true,
  );
  const codex = credential.route === 'chatgpt-subscription';
  const reasoning = yield* reasoningOf(plan, config, codex);
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
    billing: credential.usageRoute,
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
      background: backgroundOn(settings.background, {
        protocol,
        modelName: config.id,
        textOnly: request.textOnly,
      }),
      fetch: yield* modelFetch,
    },
  });
  const turn = { protocol, modelName: config.id, textOnly: request.textOnly };
  return {
    ...commonOf(plan),
    config,
    model: bound.model,
    origin: bound.origin,
    route,
    forcedToolChoice: bound.forcedToolChoice,
    persistentConnection: bound.persistentConnection,
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
