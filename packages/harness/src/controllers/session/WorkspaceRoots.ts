/**
 * The workspace a session graph works on (PRD one-fold-three-renderers,
 * 7.3): the storage root of `@platform/workspaceRoots`, provided per session
 * by `sessionLayer.ts` from the session's own roots and per webview session
 * by `webviewSessionLayer.ts` from the session key on the wire.
 * `SessionView.key` is `storage`, the same value that keys both layer maps,
 * so no fold arm carries a session key. Effect code reads roots from
 * context, which is why the process ever had an async-local carrier to retire
 * (#12421): Effect's scheduler drains many fibers' continuations in one turn,
 * so ambient state bleeds across fibers. The storage root is the one fact
 * every graph has; the config provider rides along for the process reader's
 * replay-time transcript-verbosity input. A webview has no config provider;
 * the process reader carries that input through the replay wire.
 */
import { Context } from 'effect';

import type { ConfigProvider } from '@platform/interfaces';

export class WorkspaceRoots extends Context.Service<
  WorkspaceRoots,
  /** The storage root of `@platform/workspaceRoots`, as a plain string: a
   *  webview's graph must not name the host module, which reaches Node. The
   *  config provider is the process session's own; the replay wire carries
   *  its sampled verbosity to a webview graph, which has no provider. */
  {
    readonly storage: string;
    readonly config?: ConfigProvider;
  }
>()('@texra/session/WorkspaceRoots') {}
