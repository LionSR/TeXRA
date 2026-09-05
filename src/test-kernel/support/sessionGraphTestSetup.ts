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
import { processOwnerId } from '@agent/runtime';
import { installProcessRuntime } from '@controllers/session/sessionLayer';

let installed = false;

/**
 * Install the runtime and graph family for the current module graph, once:
 * a session built on it (the file's default session, a suite's) keeps its
 * readers for the file's whole life, so a second install must not dispose
 * the runtime they run on. A graph is released when its last session is
 * disposed, so suites that dispose their sessions get fresh graphs.
 */
export function installTestSessionGraphs(): void {
  if (installed) return;
  installed = true;
  installProcessRuntime(processOwnerId('vitest'));
}

installTestSessionGraphs();
