/**
 * Model access: which model, on which route, with which credential. A
 * binding reads the settings once (`modelSettings`), decides the route over
 * them (`routeDecision`), and makes that route a `Model` with the one
 * credential it bills (`binding`, `credentials`). Its failures are llm's
 * `ModelError` as raised, or `RouteUnavailable` when no route can carry the
 * call; a run records either as its verdict (`modelFailureOf`).
 *
 * Built where a run's project environment is in force (its `.env` as the
 * `ConfigProvider`, its proxy as `ProjectEnvironment`): the layer captures
 * them, so every credential and every request of a binding follows the
 * project the run belongs to, whoever calls.
 */
import { ConfigProvider, Context, Effect, Layer, type Scope } from 'effect';
import { HttpClient } from 'effect/http';
import {
  type ModelConfig,
  type ModelError,
  type ModelRoute,
  selectModel,
} from '@texra-ai/llm';
import { SubscriptionAccounts } from '@texra-ai/llm/node';

import type { RoutePolicy } from '@agent/runtime/ModelRetryGate';
import { RouteUnavailable } from '@common/errors/agentErrors';
import { readModelSettings } from '@model/modelSettings';
import { Secrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settings';
import type {
  CredentialSwitch,
  DeclinableUsageRoute,
  ModelBackend,
} from '@shared/schemas';
import { ProjectEnvironment } from '@utils/system/nodeWorkspace';

import { bindRoute } from './binding';
import {
  admitSwitch,
  credentialSwitch,
  decideRoute,
  type SwitchRefusal,
} from './routeDecision';
import type { Binding } from '@texra-ai/llm/node';
import type { CallFailure } from './failureInfo';

/**
 * One bound model: llm's `Binding` (or the validation model's) and the facts
 * of the run the binding serves. Everything else a binding needs (its
 * credential, its reasoning choice, the toggles it was bound under) stays
 * inside model access.
 */
export interface BoundModel extends Binding {
  /** The run's model string (`provider/id[@effort][+pro]`), as its rows name it. */
  readonly modelId: string;
  /** The catalog entry the model string names, before any route's overlay:
   *  the id and list prices the usage log reports each call under. */
  readonly catalogEntry: ModelConfig;
  /** The backend its `run.config` records. */
  readonly backend: ModelBackend;
  /** The subscription routes the run had declined when this binding was
   *  decided; its `run.config` records them, and the fold unions them with
   *  every route a retry declines after. */
  readonly declinedRoutes: readonly DeclinableUsageRoute[];
  /** The route decision this binding carries out, or the validation model. */
  readonly route: ModelRoute | { readonly kind: 'validation' };
  /** Automatic retries after a failed attempt, read with the binding. */
  readonly automaticRetries: number;
  /** Bound for a text-only persona, with the model's whole output budget; a
   *  rebinding keeps it. */
  readonly textOnly: boolean;
  /** The ChatGPT plan the subscription's token names; display-only. */
  readonly plan?: string;
  /** The retry gate's routes: the model on its wire route, then the wire route. */
  readonly routes: readonly [RoutePolicy, RoutePolicy];
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
}

/** Model access for one project's runs. */
export class ModelAccess extends Context.Service<
  ModelAccess,
  {
    /** Bind a model into the caller's scope. */
    readonly bind: (
      request: BindRequest,
    ) => Effect.Effect<BoundModel, CallFailure, Scope.Scope>;
    /** Why `modelId` cannot replace `current`'s model; null when it can. */
    readonly admit: (
      modelId: string,
      current: BoundModel,
      declinedRoutes: readonly DeclinableUsageRoute[],
    ) => Effect.Effect<SwitchRefusal | null, RouteUnavailable>;
    /** The move onto the user's own credential a used-up `quota` (llm's
     *  verdict on a failure of `failed`) offers. */
    readonly credentialSwitch: (
      failed: BoundModel,
      quota: ModelError['quota'],
      declinedRoutes: readonly DeclinableUsageRoute[],
    ) => Effect.Effect<CredentialSwitch | null>;
  }
>()('@texra-ai/harness/ModelAccess') {}

/** The settings one binding reads; a subscription session that cannot be
 *  read already fails as its route. */
const settingsOf = (stores: SettingsStores) =>
  Effect.mapError(readModelSettings(stores), (error) =>
    error instanceof RouteUnavailable ? error : RouteUnavailable.of(error),
  );

/** Bind `request` over one settings read. */
const bindOver = Effect.fn('ModelAccess.bind')(function* (
  stores: SettingsStores,
  request: BindRequest,
): Effect.fn.Return<
  BoundModel,
  CallFailure,
  Scope.Scope | HttpClient.HttpClient | Secrets | SubscriptionAccounts
> {
  const selected = selectModel(request.modelId);
  const requested = request.config ?? selected?.config;
  if (requested === undefined) {
    return yield* RouteUnavailable.of(
      new Error(`Model ${request.modelId} is not registered`),
    );
  }
  const ask = selected?.request ?? {};
  const settings = yield* settingsOf(stores);
  const decision = yield* decideRoute(requested, settings, {
    ...request,
    mode: ask.mode,
  });
  return yield* bindRoute({
    request,
    requested,
    // A rebind that keeps the route's overlay as `request.config` still
    // reports its usage under the catalog entry.
    catalogEntry: selected?.config ?? requested,
    ask,
    settings,
    decision,
  });
});

/**
 * Model access over `stores` (a session's setting slots), the process
 * {@link Secrets} and its subscription accounts, for the project whose environment is in force where the
 * layer is built.
 */
export const modelAccessLayer = (
  stores: SettingsStores,
): Layer.Layer<
  ModelAccess,
  never,
  HttpClient.HttpClient | Secrets | SubscriptionAccounts
> =>
  Layer.effect(
    ModelAccess,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const env = yield* ConfigProvider.ConfigProvider;
      const project = yield* ProjectEnvironment;
      const secrets = yield* Secrets;
      const accounts = yield* SubscriptionAccounts;
      const inProject = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.provideService(ConfigProvider.ConfigProvider, env),
          Effect.provideService(ProjectEnvironment, project),
          Effect.provideService(Secrets, secrets),
          Effect.provideService(SubscriptionAccounts, accounts),
        );
      return {
        bind: (request) => inProject(bindOver(stores, request)),
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
        credentialSwitch: (failed, quota, declined) =>
          credentialSwitch(failed, quota, declined).pipe(
            Effect.provideService(Secrets, secrets),
          ),
      };
    }),
  );
