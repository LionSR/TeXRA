/**
 * The harness's installed workspace roots.
 *
 * Production holds no process-wide roots record: every session is opened over
 * the roots its composition root named (`SessionHandleInit.roots`), and every
 * run, tool call and host command reads them from the session it serves. A
 * suite, though, is its own composition root — `installFakeHost` installs one
 * fake host per test — so the roots that host was built with live here, in the
 * harness, for the assertions and seeding that happen outside any session.
 *
 * Reads go through a live view rather than a captured record, because a suite
 * installs a new fake host between tests and a helper that cached the record
 * would answer for the previous one.
 */
import type { WorkspaceRoots } from '@platform/workspaceRoots';

let installed: WorkspaceRoots | null = null;

/** Install the harness's roots; called by `installFakeHost`. */
export function initTestWorkspaceRoots(roots: WorkspaceRoots): void {
  installed = Object.freeze({ ...roots });
}

function requireInstalled(): WorkspaceRoots {
  if (!installed) {
    throw new Error(
      'No fake host is installed: the test workspace roots arrive with `installFakeHost`.',
    );
  }
  return installed;
}

const VIEW: WorkspaceRoots = Object.freeze({
  get workspace() {
    return requireInstalled().workspace;
  },
  get storage() {
    return requireInstalled().storage;
  },
  get globalStorage() {
    return requireInstalled().globalStorage;
  },
  get config() {
    return requireInstalled().config;
  },
  get workspaceState() {
    return requireInstalled().workspaceState;
  },
  get globalState() {
    return requireInstalled().globalState;
  },
});

/** The installed fake host's roots, read live. */
export function testWorkspaceRoots(): WorkspaceRoots {
  return VIEW;
}
