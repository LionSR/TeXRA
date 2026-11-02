/**
 * The test kernel's host, process and session as Effect layers, for a
 * suite that builds them per `describe` with `@effect/vitest`'s `layer(L)`
 * and `it.layer(L)`: a block states what it runs over, the block's scope
 * releases it, and nothing is installed at import or held in a slot.
 *
 * `FakeHost.layer` installs a fake host for the block (`buildPerTest: true`
 * gives each test its own, as `setupPlatform` did); `SessionGraph.layer` is
 * the process every TeXRA host composes (`processLayer` over TeXRA's plugins
 * and the installed host's ports), with no `ManagedRuntime` and no slot; and
 * `TestSession.layer` opens an ephemeral session on it. The kernel's setup
 * file still installs the suite-default host before any block builds, and
 * the four setup modules stay beside these until every suite has moved.
 */

// Third-party imports
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Path,
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
  type ProcessServices,
  type ValidationModel,
} from '@texra-ai/harness/host';
import { Interactions } from '@agent/runtime/HostInteractions';
import { SessionOwner, type SessionServices } from '@agent/runtime/rootLaunch';
import { RouteRetries } from '@agent/runtime/run/invocation';
import { validationModelLayer } from '@cli/runtime/validationModel';
import { withForkFailureReporting } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { SessionRoots } from '@platform/rootedFs';
import {
  GlobalDatabase,
  ProjectDatabases,
  type SessionOpenError,
} from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { texraPlugins } from '@texra/tools/registry';
import type { Plugin } from '@tools/plugins';
import { ToolRegistry } from '@tools/toolTable';

import {
  createFakeHost,
  fakeSetupPlatform,
  installedHost,
  installFakeHost,
  installPlatform,
  testProcessOptions,
  type FakeHost as InstalledHost,
} from './setupPlatform';
import { testWorkspaceRoots } from './testWorkspaceRoots';
import type { FakeHostOverrides, FakePlatformOptions } from './FakePlatform';

/** A host computed when the layer builds, so a per-test temp directory
 *  made in `beforeEach` is already there. */
type HostBuilder = () => InstalledHost | Promise<InstalledHost>;

/**
 * The fake host a block runs over, installed as the process's host while
 * the layer lives: its ports, roots, secrets and environment, as
 * `installFakeHost` installs them. The release installs the suite-default
 * host again, so a block's host never outlives it.
 */
export class FakeHost extends Context.Service<FakeHost, InstalledHost>()(
  '@test/support/FakeHost',
) {
  /** A host from `options` and `overrides`, or from a builder when it must
   *  be computed at build time. */
  static layer(
    optionsOrBuilder: FakePlatformOptions | HostBuilder = {},
    overrides: FakeHostOverrides = {},
  ): Layer.Layer<FakeHost> {
    const build: HostBuilder =
      typeof optionsOrBuilder === 'function'
        ? optionsOrBuilder
        : () => createFakeHost(optionsOrBuilder, overrides);
    return Layer.effect(
      FakeHost,
      Effect.acquireRelease(
        Effect.promise(async () => {
          const host = await build();
          await installFakeHost(host);
          return host;
        }),
        () => Effect.promise(() => installPlatform()),
      ),
    );
  }
}

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

/** The process over TeXRA's plugins and `extra`, its validation route
 *  served by `model`. */
const composedProcess = (
  extra: readonly Plugin[],
  model: Layer.Layer<ValidationModel>,
) =>
  Layer.unwrap(
    Effect.sync(() =>
      processLayer({
        ...testProcessOptions(
          [
            ...texraPlugins({ name: 'vscode', setup: fakeSetupPlatform }),
            ...extra,
          ],
          installedHost().roots.storageRoot,
        ),
        processStart: Effect.succeed('vitest'),
      }).pipe(Layer.provide(model)),
    ),
    // cast: `processLayer` serves the internal `SessionOwner` beside
    // `Sessions` (provideMerge); the suites' root launches and
    // `sessionHandleOf` ask it.
  ) as Layer.Layer<ProcessServices | Sessions | SessionOwner>;

/**
 * The process every TeXRA host composes, as a layer: `processLayer` over
 * TeXRA's plugins (with the installed host's setup platform) and the fake
 * host's ports, which read the host installed when they are called, so a
 * block's graph follows its per-test hosts. Built once per block and
 * released with it, which closes the sessions still open on it. The CLI's
 * validation model stands in for a real one, as the suites open runs the
 * way validation does.
 */
export const SessionGraph = {
  layer: composedProcess([], validationModelLayer),

  /**
   * The same process with `plugins` beside TeXRA's and `model` answering
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
 * with it: the public `LocalSession` a host holds, over the installed fake
 * host's roots unless the suite names its own, and ephemeral unless its
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
    roots: WorkspaceRoots = testWorkspaceRoots(),
    options?: OpenOptions,
  ): Effect.Effect<LocalSession, SessionOpenError, Sessions | Scope.Scope> {
    return Effect.acquireRelease(
      Effect.flatMap(Sessions, (sessions) => sessions.open(roots, options)),
      (session) =>
        Effect.flatMap(Sessions, (sessions) => sessions.close(session.roots)),
    );
  }

  static layer(
    roots?: WorkspaceRoots,
    options?: OpenOptions,
  ): Layer.Layer<TestSession, SessionOpenError, Sessions> {
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

/** The sessions `isolatedTestSession` opened in this file, which name their
 *  storage roots. */
let isolatedSessions = 0;

/**
 * A session of the calling scope's own, beside the block's: over the
 * installed fake host's roots with a storage root of its own (one root
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
  Sessions | SessionOwner | Scope.Scope
> =>
  Effect.gen(function* () {
    isolatedSessions += 1;
    const roots = testWorkspaceRoots();
    const session = yield* TestSession.open(
      { ...roots, storage: `${roots.storage}/isolated/${isolatedSessions}` },
      { host: {} },
    );
    const handle = yield* sessionHandleOf(session);
    if (interactions !== undefined)
      yield* Context.get(handle, Interactions).use(interactions);
    return handle;
  });
