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
import { Context, Effect, Layer, ManagedRuntime, type Scope } from 'effect';

// Local imports
import {
  Sessions,
  type LocalSession,
  type OpenOptions,
} from '@texra-ai/harness';
import {
  processLayer,
  type ProcessRuntime,
  type ProcessServices,
} from '@texra-ai/harness/host';
import { SessionOwner } from '@agent/runtime/rootLaunch';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { validationModelLayer } from '@cli/runtime/validationModel';
import { withForkFailureReporting } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { SessionOpenError } from '@shared/session/database';
import { texraPlugins } from '@texra/tools/registry';

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
 * The process every TeXRA host composes, as a layer: `processLayer` over
 * TeXRA's plugins (with the installed host's setup platform) and the fake
 * host's ports, which read the host installed when they are called, so a
 * block's graph follows its per-test hosts. Built once per block and
 * released with it, which closes the sessions still open on it. The CLI's
 * validation model stands in for a real one, as the suites open runs the
 * way validation does.
 */
export const SessionGraph = {
  layer: Layer.unwrap(
    Effect.sync(() =>
      processLayer({
        ...testProcessOptions(
          texraPlugins({ name: 'vscode', setup: fakeSetupPlatform }),
          installedHost().roots.storageRoot,
        ),
        processStart: Effect.succeed('vitest'),
      }).pipe(Layer.provide(validationModelLayer)),
    ),
    // cast: `processLayer` serves the internal `SessionOwner` beside
    // `Sessions` (provideMerge); the suites' root launches and
    // `sessionHandleOf` ask it.
  ) as Layer.Layer<ProcessServices | Sessions | SessionOwner>,

  /**
   * A `ProcessRuntime` over the calling fiber's services, for a subject that
   * takes a host's runtime (the CLI's log sinks and view binding, a desktop
   * window's hosts): what it forks or runs there runs on the block's graph,
   * and disposing it when the scope closes releases none of the graph. The
   * fiber's whole context is captured, as a host's runtime holds its own,
   * so the subject sees exactly the services the test does.
   */
  runtime: Effect.acquireRelease(
    Effect.map(Effect.context<ProcessServices | Sessions>(), (context) =>
      withForkFailureReporting(
        ManagedRuntime.make(Layer.succeedContext(context)),
      ),
    ),
    (runtime) => runtime.disposeEffect,
  ) satisfies Effect.Effect<
    ProcessRuntime,
    never,
    ProcessServices | Sessions | Scope.Scope
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
): Effect.Effect<SessionHandle, never, SessionOwner> =>
  Effect.flatMap(SessionOwner, (owner) =>
    Effect.flatMap(owner.list, (open) => {
      const handle = open.find(
        (candidate) => candidate.roots.storage === session.roots.storage,
      );
      return handle === undefined
        ? Effect.die(
            new Error(`No session is open at ${session.roots.storage}.`),
          )
        : Effect.succeed(handle);
    }),
  );
