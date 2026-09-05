/**
 * The workspace a session graph works on (PRD one-fold-three-renderers,
 * 7.3): the four per-workspace host roots of `@platform/workspaceRoots`,
 * provided per session by `sessionLayer.ts` from the session's own roots.
 * `SessionView.key` is `storage`, the same value that keys the `Sessions`
 * layer map, so no fold arm carries a session key. Effect code reads roots
 * from context, never from the async-local `workspaceRoots()`: Effect's
 * scheduler drains many fibers' continuations in one turn, so that state
 * bleeds across fibers.
 */
import { Context } from 'effect';

import type { WorkspaceRoots as HostWorkspaceRoots } from '@platform/workspaceRoots';

export class WorkspaceRoots extends Context.Service<
  WorkspaceRoots,
  HostWorkspaceRoots
>()('@texra/session/WorkspaceRoots') {}
