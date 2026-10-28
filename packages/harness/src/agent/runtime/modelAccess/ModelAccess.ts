/**
 * Model access: which model, on which route, with which credential. A
 * binding reads the settings once (`modelSettings`), decides the route over
 * them (`routeDecision`), and makes that route a `Model` with the one
 * credential it bills (`binding`, `credentials`). Its failures are llm's
 * `ModelError` as raised, or `RouteUnavailable` when no route can carry the
 * call; `failureInfo` words either for the run's rows.
 *
 * Built where a run's project environment is in force (its `.env` as the
 * `ConfigProvider`, its proxy as `ProjectEnvironment`): the layer captures
 * them, so every credential and every request of a binding follows the
 * project the run belongs to, whoever calls.
 */
import { ConfigProvider, Context, Effect, Layer, type Scope } from 'effect';
import { HttpClient } from 'effect/http';
import {
  type Model,
  type ModelConfig,
  type ModelOrigin,
  type ModelRoute,
  selectModel,
  type TurnRequest,
} from '@texra-ai/llm';

import { getHelperModelName } from '@agent/runtime/helperModelName';
import type { RoutePolicy } from '@agent/runtime/ModelRetryGate';
import { RouteUnavailable } from '@common/errors/agentErrors';
import {
  readModelOptions,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { readModelSettings } from '@model/modelSettings';
import type { StateReadFailed } from '@platform/interfaces';
import type {
  CredentialSwitch,
  DeclinableUsageRoute,
  ModelBackend,
  RetryErrorInfo,
} from '@shared/schemas';
import { ProjectEnvironment } from '@utils/system/nodeWorkspace';

import { bindRoute } from './binding';
import {
  admitSwitch,
  credentialSwitch,
  decideRoute,
  type SwitchRefusal,
} from './routeDecision';
import type { CallFailure } from './failureInfo';

/**
 * One bound model: the llm `Model` and the facts of its binding the run
 * reads. Everything else a binding needs (its credential, its reasoning
 * choice, the toggles it was bound under) stays inside model access.
 */
export interface BoundModel {
  /** The run's model string (`provider/id[@effort][+pro]`), as its rows name it. */
  readonly modelId: string;
  /** The backend its `run.config` records. */
  readonly backend: ModelBackend;
  /**
   * The config the model runs and bills with on its route: its window, its
   * prices, and the media its route carries (`capabilities`).
   */
  readonly config: ModelConfig;
  readonly model: Model;
  readonly origin: ModelOrigin;
  /** The route decision this binding carries out. */
  readonly route: ModelRoute;
  /** Automatic retries after a failed attempt, read with the binding. */
  readonly automaticRetries: number;
  /** Bound for a text-only persona, with the model's whole output budget; a
   *  rebinding keeps it. */
  readonly textOnly: boolean;
  /** The route can be told to call one named tool. */
  readonly forcedToolChoice: boolean;
  /** One connection a failed turn invalidates (the Responses WebSocket). */
  readonly persistentConnection: boolean;
  /** The service tier and subscription plan pricing bills, where the route names them. */
  readonly billing: { readonly serviceTier?: 'fast'; readonly plan?: string };
  /** The retry gate's routes: the model on its wire route, then the wire route. */
  readonly routes: readonly [RoutePolicy, RoutePolicy];
  /** How the next turn is delivered, from the live toggles. */
  readonly delivery: Effect.Effect<TurnRequest['mode'], StateReadFailed>;
  /** The subscription access token the binding sends: what a renew names. */
  readonly subscriptionToken?: string;
}

/** What a run asks to bind. */
export interface BindRequest {
  /** The run's model string; it also carries the effort, thinking and mode. */
  readonly modelId: string;
  /** A route's overlay to keep, else the catalog entry the string names. */
  readonly config?: ModelConfig;
  /** A resumed run's backend wins over today's default route. */
  readonly backend?: ModelBackend;
  /** The routes the run declined, as its rows record them. */
  readonly declinedRoutes: readonly DeclinableUsageRoute[];
  readonly textOnly: boolean;
  readonly temperature: number;
  /** The subscription token its provider rejected: refreshed before binding
   *  while it is still the stored one (`BoundModel.subscriptionToken`). */
  readonly rejected?: string;
}

/** The configured helper model, for one call; `rejected` as for a run's. */
interface HelperRequest {
  readonly purpose: 'helper';
  readonly rejected?: string;
}

/** Model access for one project's runs. */
export class ModelAccess extends Context.Service<
  ModelAccess,
  {
    /** Bind a run's model, or the configured helper model, into the caller's scope. */
    readonly bind: (
      request: BindRequest | HelperRequest,
    ) => Effect.Effect<BoundModel, CallFailure, Scope.Scope>;
    /** Why `modelId` cannot replace `current`'s model; null when it can. */
    readonly admit: (
      modelId: string,
      current: BoundModel,
      declinedRoutes: readonly DeclinableUsageRoute[],
    ) => Effect.Effect<SwitchRefusal | null, RouteUnavailable>;
    /** The move onto the user's own credential a failure on `failed` offers. */
    readonly credentialSwitch: (
      failed: BoundModel,
      recorded: RetryErrorInfo,
      declinedRoutes: readonly DeclinableUsageRoute[],
    ) => Effect.Effect<CredentialSwitch | null>;
  }
>()('@texra-ai/harness/ModelAccess') {}

/** The settings one binding reads. */
const settingsOf = (stores: ModelOptionStores) =>
  Effect.mapError(readModelSettings(stores), RouteUnavailable.of);

/** The helper model's request: the configured model, if it can serve now. */
const helperRequest = Effect.fn('ModelAccess.helper')(function* (
  stores: ModelOptionStores,
): Effect.fn.Return<BindRequest, RouteUnavailable> {
  const modelId = yield* Effect.mapError(
    getHelperModelName(stores),
    RouteUnavailable.of,
  );
  const [option] = yield* Effect.mapError(
    readModelOptions(stores, [modelId]),
    RouteUnavailable.of,
  );
  const reason = option?.unavailableReason;
  if (reason) return yield* RouteUnavailable.of(new Error(reason));
  // One-shot deterministic text: the whole output budget, never sampled.
  return { modelId, declinedRoutes: [], textOnly: true, temperature: 0 };
});

/** Bind `request` over one settings read. */
const bindOver = Effect.fn('ModelAccess.bind')(function* (
  stores: ModelOptionStores,
  request: BindRequest,
): Effect.fn.Return<
  BoundModel,
  CallFailure,
  Scope.Scope | HttpClient.HttpClient
> {
  const selected = selectModel(request.modelId);
  const catalog = request.config ?? selected?.config;
  if (catalog === undefined) {
    return yield* RouteUnavailable.of(
      new Error(`Model ${request.modelId} is not registered`),
    );
  }
  const ask = selected?.request ?? {};
  const settings = yield* settingsOf(stores);
  // The wire id "prefer short model names" promises; a provider mode
  // (OpenAI `pro`) keeps the pinned id.
  const short = catalog.shortName;
  const requested =
    ask.mode === undefined &&
    settings.preferShortModelNames &&
    short &&
    short !== catalog.id
      ? { ...catalog, id: short }
      : catalog;
  const decision = yield* decideRoute(requested, settings, {
    ...request,
    mode: ask.mode,
  });
  return yield* bindRoute(
    {
      request,
      requested,
      ask,
      settings,
      decision,
      backend: request.backend ?? decision.backend,
    },
    stores,
  );
});

/**
 * Model access over `stores` (a session's setting slots and the process
 * secret store), for the project whose environment is in force where the
 * layer is built.
 */
export const modelAccessLayer = (
  stores: ModelOptionStores,
): Layer.Layer<ModelAccess, never, HttpClient.HttpClient> =>
  Layer.effect(
    ModelAccess,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const env = yield* ConfigProvider.ConfigProvider;
      const project = yield* ProjectEnvironment;
      const inProject = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.provideService(ConfigProvider.ConfigProvider, env),
          Effect.provideService(ProjectEnvironment, project),
        );
      return {
        bind: (request) =>
          inProject(
            'purpose' in request
              ? Effect.flatMap(helperRequest(stores), (helper) =>
                  bindOver(stores, { ...helper, rejected: request.rejected }),
                )
              : bindOver(stores, request),
          ),
        admit: (modelId, current, declined) => {
          if (current.modelId === modelId) return Effect.succeed(null);
          const selected = selectModel(modelId);
          if (!selected) {
            const reason = `Model ${modelId} is not registered`;
            return Effect.succeed({ reason, message: reason });
          }
          return inProject(
            Effect.flatMap(settingsOf(stores), (settings) =>
              admitSwitch(selected, current.backend, settings, declined),
            ),
          );
        },
        credentialSwitch: (failed, recorded, declined) =>
          credentialSwitch(failed, recorded, declined, stores.secrets),
      };
    }),
  );
