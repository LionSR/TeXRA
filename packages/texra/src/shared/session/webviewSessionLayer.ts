/**
 * A session's view where its store is not: the webviews, the Electron
 * renderer, and a window or `texra run` reading the background service. The
 * caller hands `remoteSessionView` the read its transport answers (the
 * session channel's `session.frames`, the service's `task.watch`); the view
 * calls it again for every transcript set, from where it stands, and
 * interrupts the read it replaces.
 *
 * A webview entry makes its one Effect runtime with `installWebviewRuntime`;
 * the transport that installed it disposes it, once, on the shutdown path
 * its entry drives.
 */
import { Context, Effect, Layer, ManagedRuntime, type Scope } from 'effect';

// The browser entry, not the harness root: this runs in the webview, which
// must not evaluate the Node process composition.
import {
  RemoteSessionView,
  SessionInputs,
  viewDiagnosticsLayer,
  withForkFailureReporting,
} from '@texra-ai/harness/transcript';

/** The view of the session `key` over `read`, for the caller's scope. */
export const remoteSessionView = (
  key: string,
  read: Context.Service.Shape<typeof SessionInputs>['read'],
): Effect.Effect<
  Context.Service.Shape<typeof RemoteSessionView>,
  never,
  Scope.Scope
> =>
  Layer.build(
    RemoteSessionView.layer(key).pipe(
      Layer.provide(Layer.succeed(SessionInputs)({ read })),
    ),
  ).pipe(Effect.map((context) => Context.get(context, RemoteSessionView)));

/**
 * Make the one Effect runtime of this webview: called by the webview
 * transport exactly once per module evaluation and disposed by it, on the
 * one shutdown path the entry drives. Fork reporting applies here as it
 * does to the process runtime; the logger layer is the harness's view
 * logger (the redacting sink), not the default console logger.
 */
export function installWebviewRuntime(): ManagedRuntime.ManagedRuntime<
  never,
  never
> {
  return withForkFailureReporting(ManagedRuntime.make(viewDiagnosticsLayer));
}
