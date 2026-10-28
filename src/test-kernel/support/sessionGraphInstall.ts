import { Context, Effect, type Layer, ManagedRuntime } from 'effect';

import { Sessions } from '@texra-ai/harness';
import { processLayer } from '@texra-ai/harness/host';
import {
  type ProcessServices,
  type SessionOwner,
  withForkFailureReporting,
} from '@platform/processRuntime';
import type { Plugin } from '@tools/plugins';
import { initTestProcessRuntime } from './testProcessRuntime';
import { createFakeWorkspaceRoots } from './FakePlatform';
import { testProcessOptions } from './setupPlatform';

/**
 * The test kernel's process runtime and session graph family (PRD
 * one-fold-three-renderers, 7.7): what a composition root installs with
 * `processLayer()`, over the plugin list the setup module a test
 * file imports passes (`sessionGraphTestSetup`, TeXRA's plugins). Installed
 * when that module is imported, in the importing test file's module graph,
 * so it lands after that file's `vi.mock` registrations and the graph is
 * built over the modules the test actually mocks. `setupFakePlatform.ts`
 * deliberately imports neither: a setup file runs before any `vi.mock`, and
 * a graph built there would hold the real modules for the rest of the
 * file.
 */

/**
 * The install runs once per module graph, as module evaluation does: a
 * session built on this runtime (the file's default session, a suite's)
 * keeps its readers for the file's whole life, so nothing may dispose the
 * runtime they run on. A graph is released when its last session is
 * disposed, so suites that dispose their sessions get fresh graphs.
 *
 * The storage paths resolve at install to the worker's shared default rather
 * than the installed host's: this module evaluates before any host exists
 * for the host-free suites that reach it through a fixture, and every
 * default fake host answers that same directory — a suite with its own
 * storage root passes the records layers its path directly. The other
 * process services read the fake host installed at call time, as the bare
 * runtime's do: this runtime outlives the per-test hosts.
 */
const { storageRoot } = createFakeWorkspaceRoots();

/** Install the harness's process runtime over `plugins` and build it. */
export async function installTestSessionGraph(
  plugins: readonly Plugin[],
): Promise<void> {
  const runtime = withForkFailureReporting(
    ManagedRuntime.make(
      // cast: `processLayer` serves the internal `SessionOwner` beside
      // `Sessions` (provideMerge); the suites' root launches ask it.
      processLayer({
        ...testProcessOptions(plugins, storageRoot),
        processStart: Effect.succeed('vitest'),
      }) as Layer.Layer<ProcessServices | Sessions | SessionOwner>,
    ),
  );
  initTestProcessRuntime(
    runtime,
    Effect.map(runtime.contextEffect, Context.get(Sessions)),
  );
  // Built here, once, as a composition root's first `runPromise` builds it:
  // opening the global database reads the mount table through the spawner,
  // which is asynchronous, so the synchronous session opens the suites run
  // (`createTestSession`) need the process services already in place.
  await runtime.runPromise(Effect.void);
}
