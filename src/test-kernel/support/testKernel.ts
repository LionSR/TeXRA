/**
 * The test kernel's host, process and session as Effect layers, for a
 * suite that builds them per `describe` with `@effect/vitest`'s `layer(L)`
 * and `it.layer(L)`: a block states what it runs over, the block's scope
 * releases it, and nothing is installed at import or held in a slot.
 *
 * `FakeHost.layer` serves a fake host for the block (`buildPerTest: true`
 * gives each test its own); `SessionGraph.layer` is the process a host
 * composes (`processLayer` over the host's app and ports), built over the
 * block's host, with no `ManagedRuntime` (`SessionGraph.hosted` brings a
 * default host); and `TestSession.layer` opens an ephemeral session on it.
 * No host exists by default: a block names the host it runs over.
 */

// Node imports
import { rm } from 'node:fs/promises';

// Third-party imports
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Ref,
  type Scope,
} from 'effect';
import { HttpClient } from 'effect/http';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

// Local imports
import {
  Sessions,
  type LocalSession,
  type OpenOptions,
} from '@texra-ai/harness';
import {
  AgentCatalog,
  AgentDirectories,
  AppSignals,
  AppState,
  GlobalStorageFs,
  GlobalValues,
  processLayer,
  Secrets,
  StateStores,
  ToolAvailability,
  ToolCatalog,
  UsageLog,
  type HostInteractions,
  type ProcessRuntime,
  type StateStore,
  type ProcessServices,
  type ValidationModel,
} from '@texra-ai/harness/host';
import {
  attachInteractions,
  Interactions,
} from '@agent/runtime/HostInteractions';
import { SessionOwner, type SessionServices } from '@agent/runtime/rootLaunch';
import { RouteRetries } from '@agent/runtime/ModelRetryGate';
import { validationModelLayer } from '@cli/runtime/models/validationModel';
import { withForkFailureReporting } from '@platform/processRuntime';
import type { AgentDirectoriesPort } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { SessionRoots } from '@platform/rootedFs';
import {
  GlobalDatabase,
  ProjectDatabases,
  type SessionOpenError,
} from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import type { Plugin } from '@tools/plugins';
import { ToolRegistry } from '@tools/toolTable';

import {
  createFakeHost,
  type FakeHost as InstalledHost,
} from './setupPlatform';
import { unprobedToolAvailability } from './toolAvailabilityTestLayer';
import type { FakeHostOverrides, FakePlatformOptions } from './FakePlatform';

/** A host computed when the layer builds, so a per-test temp directory
 *  made in `beforeEach` is already there. */
type HostBuilder = () => InstalledHost | Promise<InstalledHost>;

/**
 * The host a block's process follows: the block's `FakeHost.layer` makes it,
 * and a test's own `FakeHost.layer` inside the block points it at the test's
 * host while that layer lives. A process is built once per block while hosts
 * change per test, so its ports read this on every call.
 */
class CurrentHost extends Context.Service<
  CurrentHost,
  Ref.Ref<InstalledHost>
>()('@test/support/CurrentHost') {}

/**
 * The fake host a block or a test runs over, for the layer's lifetime; the
 * release removes its root. Inside a block that already has one, it also points the block's process
 * at this host until its release, which points it back.
 */
export class FakeHost extends Context.Service<FakeHost, InstalledHost>()(
  '@test/support/FakeHost',
) {
  /** A host from `options` and `overrides`, or from a builder when it must
   *  be computed at build time. */
  static layer(
    optionsOrBuilder: FakePlatformOptions | HostBuilder = {},
    overrides: FakeHostOverrides = {},
  ): Layer.Layer<FakeHost | CurrentHost> {
    const build: HostBuilder =
      typeof optionsOrBuilder === 'function'
        ? optionsOrBuilder
        : () => createFakeHost(optionsOrBuilder, overrides);
    return Layer.effectContext(
      Effect.gen(function* () {
        const host = yield* Effect.acquireRelease(
          Effect.promise(async () => build()),
          ({ root }) =>
            Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const outer = yield* Effect.serviceOption(CurrentHost);
        const current = Option.isSome(outer)
          ? outer.value
          : yield* Ref.make(host);
        if (Option.isSome(outer))
          yield* Effect.acquireRelease(Ref.getAndSet(current, host), (was) =>
            Ref.set(current, was),
          );
        return Context.make(FakeHost, host).pipe(
          Context.add(CurrentHost, current),
        );
      }),
    );
  }
}

/** A block process's host ports: each member reads the host the block
 *  points at when it is called. */
const followedPorts = (current: Ref.Ref<InstalledHost>) => {
  const host = () => Ref.getUnsafe(current);
  const secrets: PlatformSecrets = {
    get: (key) => host().secrets.get(key),
    set: (key, value) => host().secrets.set(key, value),
    delete: (key) => host().secrets.delete(key),
    listStoredKeys: () => host().secrets.listStoredKeys(),
  };
  const appState: StateStore = {
    get: (key) => Effect.suspend(() => host().roots.globalState.get(key)),
    update: (key, value) => host().roots.globalState.update(key, value),
    modify: (key, change) =>
      Effect.suspend(() => host().roots.globalState.modify(key, change)),
  };
  const agentDirectories: AgentDirectoriesPort = {
    custom: () => host().platform.agentDirectories.custom(),
    customConfigured: () => host().platform.agentDirectories.customConfigured(),
    builtIn: () => host().platform.agentDirectories.builtIn(),
    teamMembers: (repoState, teamId) =>
      host().app.teamMembers?.(repoState, teamId) ?? Effect.succeed(undefined),
  };
  // A host without a setup platform has none of its members, as a host that
  // passes none.
  const setup: SetupPlatformShape = {
    get commands() {
      return host().setup?.commands;
    },
    get terminal() {
      return host().setup?.terminal;
    },
  };
  return { secrets, appState, agentDirectories, setup };
};

/**
 * The services a host's `ProcessRuntime` holds, one tag each, for
 * `Context.pick`: the `ProcessServices` type is a union nothing enumerates
 * as values, so they are listed once here. Every process serves the
 * platform services (`PlatformServices`): its `ProcessIdentity`, the Node
 * `FileSystem`, `Path` and `ChildProcessSpawner`, `GlobalStorageFs`, the
 * `GlobalDatabase` and `ProjectDatabases` handles, the `HttpClient`,
 * `Secrets`, `AppState`, `AgentDirectories`, `GlobalValues`, `StateStores`,
 * `UsageLog` and `AppSignals`. The agent runtime adds (`RunServices`) the
 * `AgentCatalog`, the model routes' `RouteRetries` gate, the `ToolRegistry`
 * and `ToolAvailability`; the composition adds its `ToolCatalog`; and a
 * composition root opens its sessions through `Sessions`, with the internal
 * `SessionOwner` beside it, which the suites' root launches ask.
 */
const PROCESS_SERVICES = [
  ProcessIdentity,
  FileSystem.FileSystem,
  Path.Path,
  ChildProcessSpawner,
  GlobalStorageFs,
  GlobalDatabase,
  ProjectDatabases,
  HttpClient.HttpClient,
  Secrets,
  AppState,
  AgentDirectories,
  GlobalValues,
  StateStores,
  UsageLog,
  AppSignals,
  AgentCatalog,
  RouteRetries,
  ToolRegistry,
  ToolAvailability,
  ToolCatalog,
  Sessions,
  SessionOwner,
] as const;

/** The process over the host's app (its settings and plugins) and `extra`, its validation route
 *  served by `model`, built over the block's host. */
const composedProcess = (
  extra: readonly Plugin[],
  model: Layer.Layer<ValidationModel>,
) =>
  // `processLayer` serves the internal `SessionOwner` beside `Sessions`
  // (provideMerge); the suites' root launches and `sessionHandleOf` ask it.
  // cast: the process layer provides `SessionOwner`, which its type omits.
  Layer.unwrap(
    Effect.gen(function* () {
      const host = yield* FakeHost;
      const ports = followedPorts(yield* CurrentHost);
      return processLayer({
        // Under the host's storage root, the worker's: its global storage,
        // and its mcp.json rather than the developer's `~/.texra/mcp.json`.
        storageRoot: host.roots.storageRoot,
        settings: host.app.settings,
        plugins: [...host.app.plugins(ports.setup), ...extra],
        secrets: Secrets.layer(ports.secrets),
        appState: AppState.layer(ports.appState),
        agentDirectories: Layer.succeed(AgentDirectories)(
          ports.agentDirectories,
        ),
        toolAvailability: unprobedToolAvailability,
        // The process reports no usage; the telemetry suite starts its own.
        usageLog: UsageLog.disabled,
        // The suite's captured entries are the assertion surface: emit every
        // level the programs run and let each test filter what it reads.
        minimumLogLevel: 'Trace',
        processStart: Effect.succeed('vitest'),
      }).pipe(Layer.provide(model));
    }),
  ) as Layer.Layer<
    ProcessServices | Sessions | SessionOwner,
    never,
    FakeHost | CurrentHost
  >;

/**
 * The process a host composes, as a layer over the block's fake host:
 * `processLayer` over the host's app (`HARNESS_APP` unless the host names
 * another) and the fake host's ports. The process reads the host as
 * it builds and after (its tool switches, whether a custom agents directory
 * is set), and its ports read the host the block points at when they are
 * called, so a block's graph follows its per-test hosts. Built once per block and
 * released with it, which closes the sessions still open on it. The CLI's
 * validation model stands in for a real one, as the suites open runs the
 * way validation does.
 */
const graph = composedProcess([], validationModelLayer);

export const SessionGraph = {
  layer: graph,

  /**
   * The same process over a default fake host of the block's own, for a
   * block that names none: its tests run over that host, or over a
   * per-test `FakeHost.layer` that replaces it for the test. A block that
   * names its own host composes `layer` over it instead
   * (`Layer.provideMerge(SessionGraph.layer, FakeHost.layer(options))`).
   */
  hosted: Layer.provideMerge(graph, FakeHost.layer()),

  /**
   * The same process with `plugins` beside the app's and `model` answering
   * every model call: for a case that composes two processes in turn, as a
   * restart with a changed plugin does.
   */
  with: composedProcess,

  /**
   * A `ProcessRuntime` over the calling fiber's services, for a subject that
   * takes a host's runtime (the CLI's log sinks and view binding, a desktop
   * window's hosts): what it forks or runs there runs on the block's graph,
   * and disposing it when the scope closes releases none of the graph. Only
   * the process services travel (`PROCESS_SERVICES`), never the fiber's
   * scope or a test's own services: a program run on the runtime would
   * otherwise register its cleanup against the block layer's scope.
   */
  runtime: Effect.acquireRelease(
    Effect.map(
      Effect.context<ProcessServices | Sessions | SessionOwner>(),
      (context) =>
        withForkFailureReporting(
          ManagedRuntime.make(
            Layer.succeedContext(Context.pick(...PROCESS_SERVICES)(context)),
          ),
        ),
    ),
    (runtime) => runtime.disposeEffect,
  ) satisfies Effect.Effect<
    ProcessRuntime,
    never,
    ProcessServices | Sessions | SessionOwner | Scope.Scope
  >,
};

/**
 * A session on the block's graph, open while the layer lives and closed
 * with it: the public `LocalSession` a host holds, over the fake host's
 * roots unless the suite names its own, and ephemeral unless its
 * `options` ask for the root's store. One root holds one session, so a
 * per-test block reopens it for each test once the previous test's has
 * closed.
 */
export class TestSession extends Context.Service<TestSession, LocalSession>()(
  '@test/support/TestSession',
) {
  /** The session for the calling scope, for a test whose roots are only
   *  known in its body; closed when the scope closes. */
  static open(
    roots?: WorkspaceRoots,
    options?: OpenOptions,
  ): Effect.Effect<
    LocalSession,
    SessionOpenError,
    Sessions | FakeHost | Scope.Scope
  > {
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        return yield* sessions.open(roots ?? (yield* FakeHost).roots, options);
      }),
      (session) =>
        Effect.flatMap(Sessions, (sessions) => sessions.close(session.roots)),
    );
  }

  static layer(
    roots?: WorkspaceRoots,
    options?: OpenOptions,
  ): Layer.Layer<TestSession, SessionOpenError, Sessions | FakeHost> {
    return Layer.effect(TestSession, TestSession.open(roots, options));
  }
}

/**
 * The internal handle of `session` (its log, requests, interactions and
 * run registry), for a suite that seeds rows or drives the session as the
 * harness does; a host never holds it. The session must be open on this
 * fiber's graph.
 */
export const sessionHandleOf = (
  session: LocalSession,
): Effect.Effect<Context.Context<SessionServices>, never, SessionOwner> =>
  Effect.flatMap(SessionOwner, (owner) =>
    Effect.flatMap(owner.list, (open) => {
      const handle = open.find(
        (candidate) =>
          Context.get(candidate, SessionRoots).storage ===
          session.roots.storage,
      );
      return handle === undefined
        ? Effect.die(
            new Error(`No session is open at ${session.roots.storage}.`),
          )
        : Effect.succeed(handle);
    }),
  );

/** The sessions `isolatedTestSession` opened in this worker, across every
 *  file it runs: each names its storage root by its number, so no two of
 *  them share one. */
let isolatedSessions = 0;

/**
 * A session of the calling scope's own, beside the block's: over the
 * fake host's roots with a storage root of its own (one root
 * holds one session, so a test opens as many as it needs), with
 * `interactions` attached as its presentation host when given. It is
 * opened as by a host whose person answers from the view (`host: {}`), so
 * a request its runs open waits for its decision rather than being denied.
 * Returns the internal handle a suite seeds rows on and hands run-scoped
 * code; the session closes with the scope.
 */
export const isolatedTestSession = (
  interactions?: HostInteractions,
): Effect.Effect<
  Context.Context<SessionServices>,
  SessionOpenError,
  Sessions | SessionOwner | FakeHost | Scope.Scope
> =>
  Effect.gen(function* () {
    isolatedSessions += 1;
    const { roots } = yield* FakeHost;
    const session = yield* TestSession.open(
      { ...roots, storage: `${roots.storage}/isolated/${isolatedSessions}` },
      { host: {} },
    );
    const handle = yield* sessionHandleOf(session);
    if (interactions !== undefined)
      yield* attachInteractions(
        Context.get(handle, Interactions),
        interactions,
      );
    return handle;
  });
