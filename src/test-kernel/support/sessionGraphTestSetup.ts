import { Effect } from 'effect';

import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import { initTestProcessRuntime } from './testProcessRuntime';
import { createFakeWorkspaceRoots } from './FakePlatform';
import {
  fakeHostAgentResume,
  fakeHostAppState,
  fakeHostAuth,
  fakeHostLanguageModel,
  fakeHostSecrets,
  fakeSetupPlatform,
} from './setupPlatform';

/**
 * The test kernel's process runtime and session graph family (PRD
 * one-fold-three-renderers, 7.7): what a composition root installs beside
 * `initPlatform()`. Installed at import, in the importing test file's module
 * graph, so it lands after that file's `vi.mock` registrations and the graph
 * is built over the modules the test actually mocks. `setupFakePlatform.ts`
 * deliberately does not import this module: a setup file runs before any
 * `vi.mock`, and a graph built there would hold the real modules for the
 * rest of the file.
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

initTestProcessRuntime(
  installProcessRuntime({
    processStart: Effect.sync(() => {
      identityReads.count += 1;
      return 'vitest';
    }),
    globalStorage,
    secrets: fakeHostSecrets,
    appState: fakeHostAppState,
    // Suites swap the account plane with their host; the default host's
    // answers signed-out.
    auth: fakeHostAuth,
    languageModel: fakeHostLanguageModel,
    agentResume: fakeHostAgentResume,
    setup: fakeSetupPlatform,
    // The Node hosts' layer: inert until a Lean tool is invoked.
    lean: directLeanLanguageServices(),
  }),
);
