/**
 * The webview's Effect graphs (PRD one-fold-three-renderers, 7.3, 7.7):
 * one per session key, in a `LayerMap`, built on the one `ManagedRuntime`
 * a webview entry makes with `installWebviewRuntime`. SessionInputs is fed
 * directly by the ordered frames; the same SessionViewService folds them
 * in the sidebar, editor tab, and Electron renderer. SessionFrames carries
 * the host snapshot separately from the fold.
 *
 * The shell opens a session with `WebviewSessions.open(key)`, begins a
 * generation on its frames right before it posts the `Subscribe` up, and
 * feeds every frame the bridge delivers to `frames.feed` in arrival order. The transport
 * that installed the runtime disposes it, once, on the shutdown path its
 * entry drives.
 */
import { Context, Effect, Layer, LayerMap, ManagedRuntime } from 'effect';

import { SessionInputs } from '@shared/session/sessionInputs';
import { SessionFrames } from '@shared/session/sessionFrames';
import { TranscriptSubscriptions } from './sessionSources';
import { SessionViewService } from './SessionView';
import { WorkspaceRoots } from './WorkspaceRoots';

/** The graph of one session key. `Layer.fresh` for the same reason as the
 *  runtime's: static layers memoize by reference across the map. */
const webviewSessionLayer = (key: string) =>
  Layer.fresh(
    SessionViewService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.effect(
            SessionInputs,
            Effect.map(SessionFrames, (frames) => ({
              read: (aggregates) => frames.inputs(aggregates),
            })),
          ),
          TranscriptSubscriptions.layer,
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
