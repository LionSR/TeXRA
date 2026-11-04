/**
 * The installed fake host's workspace roots.
 *
 * Production holds no process-wide roots record: every session is opened over
 * the roots its composition root named (`SessionHandleInit.roots`), and every
 * run, tool call and host command reads them from the session it serves. A
 * suite, though, is its own composition root (`FakeHost.layer` installs one
 * fake host per block or test), so the roots of the installed host are read
 * here, for the assertions and seeding that happen outside any session.
 *
 * Reads go through a live view rather than a captured record, because a suite
 * installs a new fake host between tests and a helper that cached the record
 * would answer for the previous one.
 */
import type { WorkspaceRoots } from '@platform/workspaceRoots';

import { installedHost } from './setupPlatform';

const installed = (): WorkspaceRoots => installedHost().roots;

const VIEW: WorkspaceRoots = Object.freeze({
  get workspace() {
    return installed().workspace;
  },
  get storageRoot() {
    return installed().storageRoot;
  },
  get storage() {
    return installed().storage;
  },
  get globalStorage() {
    return installed().globalStorage;
  },
  get config() {
    return installed().config;
  },
  get workspaceState() {
    return installed().workspaceState;
  },
  get repoState() {
    return installed().repoState;
  },
  get globalState() {
    return installed().globalState;
  },
});

/** The installed fake host's roots, read live. */
export function testWorkspaceRoots(): WorkspaceRoots {
  return VIEW;
}
