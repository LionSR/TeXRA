/**
 * The workspace a session graph works on (PRD one-fold-three-renderers,
 * 7.3): the storage root of `@platform/workspaceRoots`, provided per session
 * by `sessionLayer.ts` from the session's own roots and per webview session
 * by `webviewSessionLayer.ts` from the session key on the wire.
 * `SessionView.key` is `storage`, the same value that keys both layer maps,
 * so no fold arm carries a session key. Effect code reads roots from
 * context, never from the async-local `workspaceRoots()`: Effect's scheduler
 * drains many fibers' continuations in one turn, so that state bleeds across
 * fibers. Only the storage root is on the service: it is all the session
 * graph reads, and a webview has no config provider or state store to give.
 */
import { Context } from 'effect';

import type { WorkspaceRoots as HostWorkspaceRoots } from '@platform/workspaceRoots';

export class WorkspaceRoots extends Context.Service<
  WorkspaceRoots,
  Pick<HostWorkspaceRoots, 'storage'>
>()('@texra/session/WorkspaceRoots') {}
