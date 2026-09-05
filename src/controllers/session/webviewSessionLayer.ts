/**
 * The webview's Effect graphs (PRD one-fold-three-renderers, 7.3, 7.7):
 * one per session key, in a `LayerMap`, built on the one `ManagedRuntime`
 * a webview entry makes with `installWebviewRuntime`. A webview graph is
 * the runtime graph with the plane and the two live sources swapped for
 * their transport layers over `SessionFrames`, plus `HostState`, the host
 * snapshot level of 8.1; the fold (`SessionViewService`) is the unchanged
 * class, so the sidebar, the editor tab, and the Electron renderer fold the
 * same frames to the same view the runtime holds.
 *
 * The shell opens a session with `WebviewSessions.open(key)`, begins a
 * generation on its frames right before it posts the `Subscribe` up, and
 * feeds every frame the bridge delivers to `frames.feed`, which routes rows
 * by read, chunks, the local snapshot, and the host snapshot. The transport
 * that installed the runtime disposes it, once, on the shutdown path its
 * entry drives.
 */
import {
  Context,
  Effect,
  Layer,
  LayerMap,
  ManagedRuntime,
  Stream,
  SubscriptionRef,
} from 'effect';

import { SessionEvents } from '@shared/session/sessionEvents';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { SessionFrames } from '@shared/session/sessionFrames';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from './sessionSources';
import { SessionViewService } from './SessionView';
import { WorkspaceRoots } from './WorkspaceRoots';

/** The host snapshot level (PRD 8.1): what the shell renders but does not
 *  own, as the frames carry it; null until the first frame carries one. */
class HostState extends Context.Service<
  HostState,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<HostSnapshot | null>;
    readonly changes: Stream.Stream<HostSnapshot | null>;
  }
>()('@texra/session/HostState') {
  static readonly layer = Layer.effect(
    HostState,
    Effect.gen(function* () {
      const frames = yield* SessionFrames;
      return {
        ref: frames.host,
        changes: SubscriptionRef.changes(frames.host),
      };
    }),
  );
}

/** The graph of one session key. `Layer.fresh` for the same reason as the
 *  runtime's: static layers memoize by reference across the map. */
const webviewSessionLayer = (key: string) =>
  Layer.fresh(
    SessionViewService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          SessionEvents.transportLayer,
          LocalRuntimeSource.transportLayer,
          TextChunkSource.transportLayer,
          TranscriptSubscriptions.layer,
          HostState.layer,
        ),
      ),
      Layer.provideMerge(SessionFrames.layer),
      Layer.provide(Layer.succeed(WorkspaceRoots)({ storage: key })),
    ),
  );

/** One open session of a webview: the services its shell drives, under
 *  the scope `open` was run in. */
interface WebviewSession {
  readonly key: string;
  readonly frames: Context.Service.Shape<typeof SessionFrames>;
  readonly view: Context.Service.Shape<typeof SessionViewService>;
  readonly host: Context.Service.Shape<typeof HostState>;
  /** The shell is the graph's one port. */
  readonly subscriptions: Context.Service.Shape<typeof TranscriptSubscriptions>;
}

export class WebviewSessions extends LayerMap.Service<WebviewSessions>()(
  '@texra/session/WebviewSessions',
  { lookup: (key: string) => webviewSessionLayer(key) },
) {
  /** The session of a key, built on first open and shared until the last
   *  scope holding it closes. */
  static open(key: string) {
    return WebviewSessions.contextEffect(key).pipe(
      Effect.map((context): WebviewSession => ({
        key,
        frames: Context.get(context, SessionFrames),
        view: Context.get(context, SessionViewService),
        host: Context.get(context, HostState),
        subscriptions: Context.get(context, TranscriptSubscriptions),
      })),
    );
  }
}

export type WebviewRuntime = ManagedRuntime.ManagedRuntime<
  WebviewSessions,
  never
>;

/**
 * Make the one Effect runtime of this webview over its session family (PRD
 * 7.7): called by the webview transport exactly once per module evaluation
 * and disposed by it, on the one shutdown path the entry drives.
 */
export function installWebviewRuntime(): WebviewRuntime {
  return ManagedRuntime.make(WebviewSessions.layerNoDeps);
}
