/**
 * The webview's Effect graphs (PRD one-fold-three-renderers, 7.3, 7.7):
 * one per session key, in a `LayerMap`, built on the one `ManagedRuntime`
 * a webview entry makes with `installWebviewRuntime`. SessionInputs is fed
 * directly by the ordered frames; the harness's `RemoteSessionView` folds
 * them in the sidebar, editor tab, and Electron renderer. SessionFrames
 * carries the host snapshot separately from the fold.
 *
 * The shell opens a session with `WebviewSessions.open(key)`, begins a
 * generation on its frames right before it posts the `Subscribe` up, and
 * feeds every frame the bridge delivers to `frames.feed` in arrival order. The transport
 * that installed the runtime disposes it, once, on the shutdown path its
 * entry drives.
 */
import { Context, Effect, Layer, LayerMap, ManagedRuntime } from 'effect';

// The browser entry, not the harness root: this layer runs in the webview,
// which must not evaluate the Node process composition.
import {
  RemoteSessionView,
  SessionInputs,
  viewDiagnosticsLayer,
  withForkFailureReporting,
} from '@texra-ai/harness/transcript';
import { SessionFrames } from '@texra/shared/session/sessionFrames';

/** The graph of one session key. `Layer.fresh` for the same reason as the
 *  runtime's: static layers memoize by reference across the map. */
const webviewSessionLayer = (key: string) =>
  Layer.fresh(
    RemoteSessionView.layer(key).pipe(
      Layer.provide(
        Layer.effect(
          SessionInputs,
          Effect.map(SessionFrames, (frames) => ({
            read: (aggregates, _fromCommit, previousDebug) =>
              frames.inputs(aggregates, previousDebug),
          })),
        ),
      ),
      Layer.provideMerge(SessionFrames.layer),
    ),
  );

/** One open session of a webview: the services its shell drives, under
 *  the scope `open` was run in. */
interface WebviewSession {
  readonly frames: Context.Service.Shape<typeof SessionFrames>;
  /** The shell is the view's one subscribing port. */
  readonly view: Context.Service.Shape<typeof RemoteSessionView>;
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
        frames: Context.get(context, SessionFrames),
        view: Context.get(context, RemoteSessionView),
      })),
    );
  }
}

type WebviewRuntime = ManagedRuntime.ManagedRuntime<WebviewSessions, never>;

/**
 * Make the one Effect runtime of this webview over its session family (PRD
 * 7.7): called by the webview transport exactly once per module evaluation
 * and disposed by it, on the one shutdown path the entry drives. Fork
 * reporting applies here as it does to the process runtime; the logger
 * layer is the harness's view logger (the redacting sink), not the
 * default console logger.
 */
export function installWebviewRuntime(): WebviewRuntime {
  return withForkFailureReporting(
    ManagedRuntime.make(
      WebviewSessions.layerNoDeps.pipe(
        Layer.provideMerge(viewDiagnosticsLayer),
      ),
    ),
  );
}
