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

export class WorkspaceRoots extends Context.Service<
  WorkspaceRoots,
  /** The storage root of `@platform/workspaceRoots`, as a plain string: a
   *  webview's graph must not name the host module, which reaches Node. */
  { readonly storage: string }
>()('@texra/session/WorkspaceRoots') {}
