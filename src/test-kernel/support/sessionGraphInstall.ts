import { Context, Effect, ManagedRuntime } from 'effect';

import {
  processLayer,
  Sessions,
  type ProcessLayerOptions,
} from '@texra-ai/harness';
import { AppState, AgentDirectories } from '@platform/interfaces';
import { withForkFailureReporting } from '@platform/processRuntime';
import { UsageLog } from '@shared/usageLog';
import { mcpConfigPathOf } from '@tools/mcp/mcpConfig';
import type { Plugin } from '@tools/plugins';
import { initTestProcessRuntime } from './testProcessRuntime';
import { unprobedToolAvailability } from './toolAvailabilityTestLayer';
import { createFakeWorkspaceRoots } from './FakePlatform';
import {
  fakeHostAgentDirectories,
  fakeHostAppState,
  fakeHostLanguageModel,
  fakeHostSecrets,
} from './setupPlatform';

/**
 * The test kernel's process runtime and session graph family (PRD
 * one-fold-three-renderers, 7.7): what a composition root installs with
 * `processLayer()`, over the plugin list the setup module a test
 * file imports passes (`sessionGraphTestSetup` for TeXRA's plugins,
 * `builtinSessionGraphTestSetup` for the harness's built-ins). Installed
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
const { globalStorage } = createFakeWorkspaceRoots();

/** Reads of this install's process start: the `ProcessIdentity` layer is a
 *  process service, so it builds once however many sessions open. */
export const identityReads = { count: 0 };

/** The kernel's composition over the fake host: `processLayer`'s options
 *  with `plugins` under the global root `root`. The setting rows travel
 *  with the fake host's config (`ConfigProvider.catalog`). */
const testProcessOptions = (
  plugins: readonly Plugin[],
  root: string = globalStorage,
): ProcessLayerOptions => ({
  globalStorage: root,
  // Under the fake global root, never the developer's `~/.texra/mcp.json`.
  plugins,
  mcpConfigPath: mcpConfigPathOf(root),
  secrets: fakeHostSecrets,
  appState: AppState.layer(fakeHostAppState),
  languageModel: fakeHostLanguageModel,
  agentDirectories: AgentDirectories.layer(fakeHostAgentDirectories),
  toolAvailability: unprobedToolAvailability,
  // The harness reports no usage; the telemetry suite starts its own.
  usageLog: UsageLog.disabled,
  // The suite's captured entries are the assertion surface: emit every
  // level the programs run and let each test filter what it reads.
  minimumLogLevel: 'Trace',
});

/** A second composition in this process, for a suite that needs one: the
 *  kernel's, under the global root `root`, with a process start of its own.
 *  Fixed, as the install's is: reading the real one spawns PowerShell on
 *  Windows, seconds under CI load, and only the install's reads count in
 *  `identityReads`. */
export const testProcessLayer = (
  plugins: readonly Plugin[],
  root: string,
): ReturnType<typeof processLayer> =>
  processLayer({
    ...testProcessOptions(plugins, root),
    processStart: Effect.succeed('vitest-second'),
  });

/** Install the harness's process runtime over `plugins` and build it. */
export async function installTestSessionGraph(
  plugins: readonly Plugin[],
): Promise<void> {
  const runtime = withForkFailureReporting(
    ManagedRuntime.make(
      processLayer({
        ...testProcessOptions(plugins),
        processStart: Effect.sync(() => {
          identityReads.count += 1;
          return 'vitest';
        }),
      }),
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
